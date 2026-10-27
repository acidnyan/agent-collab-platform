// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  createContract,
  createCapability,
  createSignedAgentCard,
  createInviteToken,
  parseAndVerifyInviteToken,
  validateRelayEndpointUrl,
  signPayload,
  verifySigned,
  verifyEnvelope,
  verifyContract,
  verifyApproval,
  validateManifest,
  validateOutput,
  verifyCapabilityChain,
  verifySignedAgentCard,
  schemaNarrows,
  digest,
  openEnvelope,
  inviteRevocationId,
  resolveDid,
} from '@acp/core';
import type {
  Json,
  KeyPair,
  Schema,
  TaskManifest,
  Signed,
  SignedAgentCard,
  SignedEnvelope,
  TaskContract,
  Transition,
  CapabilityToken,
  BudgetSpec,
  RevocationList,
  Invite,
} from '@acp/core';
import { verifyAudit, type AuditBundle } from '@acp/ledger';
import { HttpRelayClient } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import type {
  AgentAdapter,
  AgentTaskContext,
  ProgressPayload,
  ProtocolEnvelope,
} from './adapter.js';
import { InteractiveCliApprovalProvider } from './approval-providers.js';
import type { ApprovalProvider } from './approval-providers.js';
import { OwnerGateway } from './gateway.js';
import { MCPProxy } from './mcp.js';
import type { ToolBackend, ToolDefinition } from './mcp.js';
import { VerificationEngine, createDelivery } from './verifier.js';
import type { Delivery, VerificationResult } from './verifier.js';
import { asJson, receiveRelay, SessionWire } from './session-audit.js';
export interface SessionResult {
  taskId: string;
  state: 'SETTLED' | 'CANCELLED';
  deliverable: Json | null;
  bundle: AuditBundle;
  verification?: VerificationResult;
}
const policy = { requiredGates: [], autoApprove: [] };
function transport(relay: RelayTransport | string, owner: KeyPair): RelayTransport {
  const client: RelayTransport =
    typeof relay === 'string' ? new HttpRelayClient(relay.replace(/\/$/, ''), owner) : relay;
  client.setRecipientKey?.(owner);
  return client.withRecipient?.(owner) ?? client;
}
function freshAudit(path?: string): void {
  if (path && existsSync(path)) throw new Error('AUDIT_FILE_ALREADY_EXISTS');
}
function sessionSignal(timeout: number, signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
}
/** Per-task queue so one session cannot dequeue another task's envelopes. */
class TaskMailbox {
  private queue: SignedEnvelope[] = [];
  private waiters: Array<() => void> = [];
  push(envelope: SignedEnvelope): void {
    this.queue.push(envelope);
    this.waiters.shift()?.();
  }
  async take(signal?: AbortSignal): Promise<SignedEnvelope> {
    for (;;) {
      signal?.throwIfAborted();
      const next = this.queue.shift();
      if (next) return next;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          this.waiters = this.waiters.filter((waiter) => waiter !== onWake);
          error ? reject(error) : resolve();
        };
        const onAbort = () => finish(new Error('SESSION_ABORTED'));
        const onWake = () => finish();
        this.waiters.push(onWake);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else if (this.queue.length) onWake();
      });
    }
  }
}
function mailboxRelay(relay: RelayTransport, mailbox: TaskMailbox): RelayTransport {
  return {
    send: (envelope) => relay.send(envelope),
    receive: (_recipientDid, _waitMs, signal) => mailbox.take(signal),
  };
}
/**
 * One reader for a recipient DID. Concurrent delegate() calls share this inbox
 * and only see envelopes for their own taskId.
 */
class RecipientInbox {
  private readonly mailboxes = new Map<string, TaskMailbox>();
  private wake?: () => void;
  private readAbort?: AbortController;
  private started = false;
  constructor(
    private readonly relay: RelayTransport,
    private readonly did: string,
  ) {}
  attach(taskId: string): TaskMailbox {
    const existing = this.mailboxes.get(taskId);
    if (existing) return existing;
    const mailbox = new TaskMailbox();
    this.mailboxes.set(taskId, mailbox);
    this.wake?.();
    this.wake = undefined;
    if (!this.started) {
      this.started = true;
      void this.pump();
    }
    return mailbox;
  }
  /** Drop the task mailbox. The shared reader stops dequeuing once none remain. */
  detach(taskId: string): void {
    this.mailboxes.delete(taskId);
    if (this.mailboxes.size === 0) this.readAbort?.abort();
  }
  private async pump(): Promise<void> {
    for (;;) {
      if (this.mailboxes.size === 0) {
        await new Promise<void>((resolve) => {
          if (this.mailboxes.size > 0) {
            resolve();
            return;
          }
          this.wake = resolve;
        });
        continue;
      }
      const controller = new AbortController();
      this.readAbort = controller;
      try {
        const envelope = await receiveRelay(this.relay, this.did, controller.signal);
        this.mailboxes.get(envelope.payload.taskId)?.push(envelope);
      } catch {
        // The last mailbox closed, or the transport aborted this read.
      }
    }
  }
}
const recipientInboxes = new WeakMap<object, Map<string, RecipientInbox>>();
function recipientInbox(
  source: object,
  relay: RelayTransport,
  did: string,
  relayUrl?: string,
): RecipientInbox {
  // String relays include the URL so one client can switch servers. The same URL still shares
  // one inbox. Object relays stay keyed only by owner DID.
  const key = relayUrl === undefined ? did : did + '\0' + relayUrl;
  let byDid = recipientInboxes.get(source);
  if (!byDid) {
    byDid = new Map();
    recipientInboxes.set(source, byDid);
  }
  let inbox = byDid.get(key);
  if (!inbox) {
    inbox = new RecipientInbox(relay, did);
    byDid.set(key, inbox);
  }
  return inbox;
}
export interface WorkerNodeOptions {
  owner: KeyPair;
  relay: RelayTransport | string;
  relayUrl?: string;
  adapter: AgentAdapter;
  name?: string;
  agentDid?: string;
  approvalProvider?: ApprovalProvider;
  auditPath?: string;
  timeoutMs?: number;
  tools?: Record<string, ToolDefinition>;
  toolBackend?: ToolBackend;
  revocation?: RevocationList;
  onEvent?: (event: string, taskId: string) => void;
}
interface Proposal {
  proposal: Signed<TaskManifest>;
  input: Json;
  capabilityChains: CapabilityToken[][];
  inviteToken?: string;
}
export class WorkerNode {
  readonly relay: RelayTransport;
  readonly agentCard: SignedAgentCard;
  readonly approvalProvider: ApprovalProvider;
  private completed = 0;
  private readonly mailboxes = new Map<string, TaskMailbox>();
  readonly controller = new AbortController();
  lastResult?: SessionResult;
  constructor(readonly options: WorkerNodeOptions) {
    this.relay = transport(options.relay, options.owner);
    this.approvalProvider =
      options.approvalProvider ?? new InteractiveCliApprovalProvider(options.owner);
    this.agentCard = createSignedAgentCard(
      {
        name: options.name ?? options.adapter.name,
        agentDid: options.agentDid ?? options.owner.did,
        relayEndpoint:
          typeof options.relay === 'string'
            ? options.relay
            : (options.relayUrl ?? 'http://in-memory.local'),
        skills: options.adapter.skills,
      },
      options.owner,
    );
  }
  invite(expiresInSeconds = 3600): string {
    return createInviteToken({ agentCard: this.agentCard, expiresInSeconds }, this.options.owner);
  }
  async register(): Promise<void> {
    await this.relay.register?.(this.agentCard);
  }
  stop(): void {
    this.controller.abort('WORKER_STOPPED');
  }
  async start(
    options: { once?: boolean; signal?: AbortSignal } = {},
  ): Promise<SessionResult | undefined> {
    await this.register();
    const idleSignal = AbortSignal.any([
      this.controller.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const jobs = new Set<Promise<void>>();
    try {
      while (!idleSignal.aborted) {
        const envelope = await receiveRelay(this.relay, this.options.owner.did, idleSignal);
        if (this.deliver(envelope)) continue;
        const job = this.beginTask(envelope, idleSignal, options.once === true);
        if (!job) continue;
        jobs.add(job);
        void job.finally(() => jobs.delete(job)).catch(() => undefined);
        if (options.once) {
          await this.pumpUntil(job, idleSignal);
          return this.lastResult;
        }
      }
    } catch (error) {
      if (!idleSignal.aborted) throw error;
    } finally {
      await Promise.allSettled([...jobs]);
    }
    return this.lastResult;
  }
  private deliver(envelope: SignedEnvelope): boolean {
    const mailbox = this.mailboxes.get(envelope.payload.taskId);
    if (!mailbox) return false;
    mailbox.push(envelope);
    return true;
  }
  private beginTask(
    first: SignedEnvelope,
    idleSignal: AbortSignal,
    once: boolean,
  ): Promise<void> | undefined {
    if (
      !verifyEnvelope(first, this.options.owner.did) ||
      first.payload.eventType !== 'PROPOSE' ||
      first.payload.seq !== 0
    ) {
      if (once) throw new Error('INVALID_PROPOSAL_ENVELOPE');
      this.options.onEvent?.('REJECTED', '');
      return;
    }
    const mailbox = new TaskMailbox();
    this.mailboxes.set(first.payload.taskId, mailbox);
    const job = this.executeTask(first, idleSignal, mailboxRelay(this.relay, mailbox))
      .then((result) => {
        this.lastResult = result;
      })
      .catch((error) => {
        if (once) throw error;
        this.options.onEvent?.('REJECTED', '');
      })
      .finally(() => {
        this.mailboxes.delete(first.payload.taskId);
      });
    return job;
  }
  /** Keep reading the shared inbox until a single task finishes, without dropping its peer's mail. */
  private async pumpUntil(job: Promise<void>, idleSignal: AbortSignal): Promise<void> {
    const wait = new AbortController();
    let failure: unknown;
    const finished = job.then(
      () => undefined,
      (error: unknown) => {
        failure = error;
      },
    );
    try {
      while (!idleSignal.aborted && failure === undefined) {
        const incoming = receiveRelay(
          this.relay,
          this.options.owner.did,
          AbortSignal.any([idleSignal, wait.signal]),
        ).then(
          (envelope) => envelope,
          (error: unknown) => {
            if (!idleSignal.aborted && !wait.signal.aborted) failure = error;
            return undefined;
          },
        );
        const envelope = await Promise.race([finished, incoming]);
        if (failure !== undefined) break;
        if (!envelope) return;
        if (!this.deliver(envelope)) this.options.onEvent?.('REJECTED', '');
      }
    } finally {
      wait.abort();
    }
    if (failure !== undefined) throw failure;
  }
  async runOnce(signal?: AbortSignal): Promise<SessionResult> {
    const idleSignal = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const first = await receiveRelay(this.relay, this.options.owner.did, idleSignal);
    return this.executeTask(first, idleSignal, this.relay);
  }
  private async executeTask(
    first: SignedEnvelope,
    idleSignal: AbortSignal,
    relay: RelayTransport,
  ): Promise<SessionResult> {
    if (
      !verifyEnvelope(first, this.options.owner.did) ||
      first.payload.eventType !== 'PROPOSE' ||
      first.payload.seq !== 0
    )
      throw new Error('INVALID_PROPOSAL_ENVELOPE');
    // PROPOSE arrives before the session wire is constructed. Open it with the same rule.
    const data = openEnvelope(first, this.options.owner) as unknown as Proposal,
      m = data.proposal?.payload;
    if (!m || first.payload.senderDid !== m.requester.ownerDid || first.payload.taskId !== m.taskId)
      throw new Error('INVALID_PROPOSAL');
    validateManifest(m);
    if (
      !verifySigned(data.proposal, m.requester.ownerDid) ||
      m.worker?.ownerDid !== this.options.owner.did ||
      m.worker.agentDid !== this.agentCard.payload.agentDid ||
      Date.parse(m.deadline) <= Date.now() ||
      Date.parse(m.createdAt) > Date.now() ||
      !validateOutput(m.io.inputSchema, data.input)
    )
      throw new Error('INVALID_PROPOSAL');
    const auditPath = this.options.auditPath
      ? this.completed++ === 0
        ? this.options.auditPath
        : this.options.auditPath.replace(/(?:\.jsonl)?$/, '.' + m.taskId + '.jsonl')
      : undefined;
    freshAudit(auditPath);
    const activeSignal = sessionSignal(
      Math.min(this.options.timeoutMs ?? 120000, Date.parse(m.deadline) - Date.now()),
      idleSignal,
    );
    const wire = new SessionWire(
      relay,
      this.options.owner,
      m.requester.ownerDid,
      m.taskId,
      [m.requester.ownerDid, this.options.owner.did],
      activeSignal,
      auditPath,
    );
    const cancelController = new AbortController();
    wire.earlyCancel = () => cancelController.abort('CANCELLED');
    let gateway: OwnerGateway | undefined, workspace: string | undefined;
    // Progress metrics are applied synchronously. The tail only serializes wire frames.
    let progressTail: Promise<void> = Promise.resolve();
    let progressFailure: unknown;
    let wireFailureSent = false;
    try {
      await wire.receiveEvent('PROPOSE', first);
      this.assertInviteActive(data);
      const contract = createContract(m, data.proposal, this.options.owner);
      const approval = await this.approvalProvider.approve({
        taskId: m.taskId,
        gate: 'contract_acceptance',
        target: contract.contractDigest,
        details: { manifest: m, capabilities: data.capabilityChains },
        signal: activeSignal,
      });
      gateway = new OwnerGateway(this.options.owner, contract, policy, this.options.revocation);
      const accepted = gateway.accept(approval);
      await wire.sendEvent('ACCEPT', { contract, transition: accepted, approval });
      this.options.onEvent?.('ACCEPT', m.taskId);
      await wire.sendEvent('START', gateway.transition('START'));
      this.options.onEvent?.('IN_PROGRESS', m.taskId);
      const extra = this.options.adapter as AgentAdapter & {
        tools?: Record<string, ToolDefinition>;
        toolBackend?: ToolBackend;
      };
      const tools = this.options.tools ?? extra.tools ?? {},
        backend = this.options.toolBackend ?? extra.toolBackend;
      if (!Array.isArray(data.capabilityChains) || data.capabilityChains.length > 32)
        throw new Error('CAPABILITY_VIOLATION: invalid chains');
      const toolsSeen = new Set<string>();
      const proxies = data.capabilityChains.map((chain) => {
        const leaf = verifyCapabilityChain(chain, {
          rootDid: m.requester.ownerDid,
          audience: this.options.owner.did,
          taskId: m.taskId,
        });
        const grant = m.permissions.grantedCapabilities.find(
          (g) =>
            g.resource === leaf.payload.resource &&
            leaf.payload.allowedTools.every((t) => g.allowedTools.includes(t)) &&
            leaf.payload.maxCalls <= g.maxInvocations &&
            Date.parse(leaf.payload.expiresAt) <= Date.parse(g.expiresAt),
        );
        if (
          !grant ||
          leaf.payload.maxDepth > m.permissions.maxDelegationDepth ||
          leaf.payload.allowedTools.some(
            (t) =>
              toolsSeen.has(t) ||
              !schemaNarrows(
                leaf.payload.argConstraints[t],
                grant.argConstraints ?? { type: 'object' },
              ),
          )
        )
          throw new Error('CAPABILITY_VIOLATION: outside manifest');
        for (const tool of leaf.payload.allowedTools) toolsSeen.add(tool);
        return new MCPProxy({
          chain,
          context: {
            rootDid: m.requester.ownerDid,
            audience: this.options.owner.did,
            taskId: m.taskId,
          },
          tools,
          backend: backend ?? {
            callTool: async () => {
              throw new Error('MCP_BACKEND_REQUIRED');
            },
          },
          gate: gateway!.approvals,
          meter: gateway!.quota,
          guard: gateway!.capabilities,
          isActive: () => gateway!.machine.state === 'IN_PROGRESS',
        });
      });
      workspace = await mkdtemp(join(tmpdir(), 'acp-adapter-'));
      const executionSignal = AbortSignal.any([
        activeSignal,
        gateway.quota.controller.signal,
        cancelController.signal,
      ]);
      let effectiveIsolationLevel = 'host_adapter';
      // Concurrent reportProgress calls must not put two PROGRESS frames on the wire
      // before the first bilateral ACK. The queue also keeps DELIVER behind them.
      const enqueueProgress = (operation: () => Promise<void>, force = false): Promise<void> => {
        const run = progressTail.then(async () => {
          if (!force) {
            if (progressFailure) throw progressFailure;
            if (executionSignal.aborted)
              throw new Error('EXECUTION_ABORTED: ' + String(executionSignal.reason));
          }
          await operation();
        });
        progressTail = run.then(
          () => undefined,
          (error: unknown) => {
            progressFailure ??= error;
          },
        );
        void run.catch(() => undefined);
        return run;
      };
      const context: AgentTaskContext = {
        taskId: m.taskId,
        manifest: structuredClone(m),
        input: structuredClone(data.input),
        workspaceDir: workspace,
        signal: executionSignal,
        reportUsage: (delta) => gateway!.quota.recordMetrics(delta),
        reportProgress: (progress) => {
          // An invalid payload poisons the session even when the adapter catches the rejection.
          // Its metrics are not charged.
          const invalidProgress = (): Promise<never> => {
            const error = new Error('INVALID_PROGRESS');
            progressFailure ??= error;
            return Promise.reject(error);
          };
          // Validate and charge quota before returning, so a later call on this turn
          // observes BUDGET_EXCEEDED without waiting for the wire queue.
          if (!progress || typeof progress.step !== 'string' || progress.step.length === 0)
            return invalidProgress();
          if (progress.percent !== undefined && typeof progress.percent !== 'number')
            return invalidProgress();
          let metricsError: unknown;
          if (progress.metrics) {
            const delta: {
              inputTokens?: number;
              outputTokens?: number;
              toolCalls?: number;
              wallTimeMs?: number;
            } = {};
            if (progress.metrics.inputTokens !== undefined)
              delta.inputTokens = progress.metrics.inputTokens;
            if (progress.metrics.outputTokens !== undefined)
              delta.outputTokens = progress.metrics.outputTokens;
            if (progress.metrics.toolInvocations !== undefined)
              delta.toolCalls = progress.metrics.toolInvocations;
            if (progress.metrics.elapsedMs !== undefined)
              delta.wallTimeMs = progress.metrics.elapsedMs;
            if (Object.keys(delta).length > 0) {
              try {
                gateway!.quota.recordMetrics(delta);
              } catch (error) {
                metricsError = error;
              }
            }
          }
          if (metricsError) {
            progressFailure ??= metricsError;
            const code = safeError(metricsError);
            return enqueueProgress(async () => {
              // Wait until any in-flight PROGRESS handshake finishes, then reject the session.
              wireFailureSent = true;
              await wire.rawSend('ERROR', { code });
              throw metricsError;
            }, true);
          }
          return enqueueProgress(async () => {
            if (progressFailure) throw progressFailure;
            if (executionSignal.aborted)
              throw new Error('EXECUTION_ABORTED: ' + String(executionSignal.reason));
            await wire.sendEvent('PROGRESS', progress);
          });
        },
        reportIsolation: (level) => {
          effectiveIsolationLevel = level;
        },
        callTool: async (tool, args) => {
          executionSignal.throwIfAborted();
          if (!args || typeof args !== 'object' || Array.isArray(args))
            throw new Error('CAPABILITY_VIOLATION: arguments');
          const index = data.capabilityChains.findIndex((c) =>
            c.at(-1)!.payload.allowedTools.includes(tool),
          );
          if (index < 0) throw new Error('CAPABILITY_VIOLATION: unauthorized tool');
          const approval =
            tools[tool] && !tools[tool].readOnly
              ? await this.approvalProvider.approve({
                  taskId: m.taskId,
                  gate: 'external_side_effect',
                  target: { name: tool, args },
                  details: { manifest: m },
                  signal: executionSignal,
                })
              : undefined;
          return asJson(await proxies[index].callTool(tool, args, approval));
        },
      };
      const output = await abortable(this.options.adapter.executeTask(context), executionSignal);
      // A task may return while a queued progress update is still waiting for its ACK.
      // Skip the drain once the task is already aborted, cancelled, or over budget.
      if (!executionSignal.aborted && !wire.cancelHandled) {
        await progressTail;
        if (progressFailure) throw progressFailure;
      }
      executionSignal.throwIfAborted();
      gateway.quota.record();
      const delivery = createDelivery(
        m.taskId,
        contract.contractDigest,
        output,
        gateway.quota.receipt(this.options.owner),
        this.options.owner,
        { effectiveIsolationLevel },
      );
      const transition = gateway.transition('DELIVER');
      await wire.sendEvent('DELIVER', { ...delivery, transition });
      this.options.onEvent?.('DELIVER', m.taskId);
      const verification = await wire.receiveEvent(['VERIFY_ACCEPT', 'VERIFY_REJECT']);
      gateway.machine.apply(verification.payload.payload as unknown as Signed<Transition>);
      if (verification.payload.eventType === 'VERIFY_REJECT')
        throw new Error('VERIFICATION_REJECTED');
      const settled = await wire.receiveEvent('SETTLED');
      gateway.machine.apply(settled.payload.payload as unknown as Signed<Transition>);
      const bundle = await wire.finishWorker();
      this.options.onEvent?.('SETTLED', m.taskId);
      return { taskId: m.taskId, state: 'SETTLED', deliverable: output, bundle };
    } catch (e) {
      if (
        gateway &&
        (wire.cancelHandled || cancelController.signal.aborted) &&
        ['ACCEPTED', 'IN_PROGRESS', 'CANCELLED'].includes(gateway.machine.state)
      ) {
        try {
          await wire.waitUntilCancelHandled();
          const body = wire.lastCancel?.payload.payload as unknown as CancelPayload | undefined;
          if (!body || body.cancelledBy !== m.requester.ownerDid || !body.transition)
            throw new Error('INVALID_CANCEL');
          if (gateway.machine.state !== 'CANCELLED') gateway.machine.apply(body.transition);
          const bundle = await wire.finishWorker();
          this.options.onEvent?.('CANCELLED', m.taskId);
          return { taskId: m.taskId, state: 'CANCELLED', deliverable: null, bundle };
        } catch (inner) {
          await wire.rawSend('ERROR', { code: safeError(inner) }).catch(() => {});
          throw inner;
        }
      }
      await progressTail;
      if (!wireFailureSent) {
        wireFailureSent = true;
        await wire.rawSend('ERROR', { code: safeError(progressFailure ?? e) }).catch(() => {});
      }
      // A quota abort already surfaces as EXECUTION_ABORTED. Keep that error.
      // A caught INVALID_PROGRESS still fails the session with the sticky error.
      if (
        progressFailure instanceof Error &&
        !(e instanceof Error && e.message.startsWith('EXECUTION_ABORTED'))
      )
        throw progressFailure;
      throw e;
    } finally {
      gateway?.close();
      if (workspace) await rm(workspace, { recursive: true, force: true });
    }
  }
  private assertInviteActive(data: Proposal): void {
    const registry = this.options.revocation;
    const token = data.inviteToken;
    if (!registry || typeof token !== 'string' || token.length === 0) return;
    registry.assertNotRevoked('invite', token);
    registry.assertNotRevoked('invite', inviteRevocationId(token));
  }
}
interface CancelPayload {
  reason?: string;
  cancelledBy: string;
  transition: Signed<Transition>;
}
function safeError(e: unknown): string {
  const s = String(e);
  if (s.includes('TOKEN_REVOKED')) return 'TOKEN_REVOKED';
  return (
    ['BUDGET', 'CAPABILITY', 'APPROVAL', 'HITL', 'INVALID', 'VERIFICATION', 'SCHEMA', 'ABORT'].find(
      (code) => s.includes(code),
    ) ?? 'EXECUTION_FAILED'
  );
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach before throwIfAborted. A quota abort can reject the adapter in the same turn.
  promise.catch(() => undefined);
  signal.throwIfAborted();
  let listener = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        listener = () => reject(new Error('EXECUTION_ABORTED: ' + String(signal.reason)));
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
export interface RequesterClientOptions {
  owner: KeyPair;
  relay?: RelayTransport | string;
  approvalProvider?: ApprovalProvider;
  verificationEngine?: VerificationEngine;
  auditPath?: string;
  timeoutMs?: number;
  allowPrivateRelay?: boolean;
}
export interface DelegateOptions {
  to: string;
  relay?: RelayTransport | string;
  title: string;
  description: string;
  input: Json;
  outputSchema?: Schema;
  budget?: Partial<BudgetSpec>;
  manifest?: TaskManifest;
  auditPath?: string;
  signal?: AbortSignal;
  capabilities?: TaskManifest['permissions']['grantedCapabilities'];
  minimumIsolationLevel?: string;
  onProgress?: (
    progress: ProgressPayload,
    envelope: ProtocolEnvelope<ProgressPayload>,
  ) => void | Promise<void>;
}
export interface DelegateWorkerTarget {
  workerDid: string;
  inviteToken?: string | Signed<Invite>;
  relayUrl?: string;
}
export interface DelegateReceipt {
  workerDid: string;
  taskId: string;
  outputDigest: string;
  deliverable: Json;
  bundle: AuditBundle;
  accepted: boolean;
}
export interface DelegateMultiResult {
  mode: 'race' | 'quorum';
  status: 'SETTLED';
  deliverable: Json;
  outputDigest: string;
  taskIds: string[];
  winners: Array<{ workerDid: string; taskId: string; outputDigest: string }>;
  receipts: DelegateReceipt[];
  cancelled: string[];
}
export interface DelegateMultiOptions {
  workers: DelegateWorkerTarget[];
  mode: 'race' | 'quorum';
  quorumSize?: number;
  title: string;
  description: string;
  input: Json;
  outputSchema?: Schema;
  budget?: Partial<BudgetSpec>;
  capabilities?: DelegateOptions['capabilities'];
  minimumIsolationLevel?: string;
  signal?: AbortSignal;
  onProgress?: DelegateOptions['onProgress'];
  auditPath?: string;
}
export class RequesterClient {
  readonly approvalProvider: ApprovalProvider;
  constructor(readonly options: RequesterClientOptions) {
    this.approvalProvider =
      options.approvalProvider ?? new InteractiveCliApprovalProvider(options.owner);
  }
  async delegate(
    options: DelegateOptions,
    hooks?: { onProgress?: DelegateOptions['onProgress'] },
  ): Promise<SessionResult> {
    const onProgress = hooks?.onProgress ?? options.onProgress;
    const invite = options.to.startsWith('acp')
      ? parseAndVerifyInviteToken(options.to, Date.now(), {
          allowPrivateRelay: this.options.allowPrivateRelay,
        })
      : undefined;
    const relayOption = options.relay ?? this.options.relay ?? invite?.relayUrl;
    if (!relayOption) throw new Error('RELAY_REQUIRED');
    if (typeof relayOption === 'string')
      validateRelayEndpointUrl(relayOption, { allowPrivateRelay: this.options.allowPrivateRelay });
    else if ('url' in relayOption && typeof relayOption.url === 'string')
      validateRelayEndpointUrl(relayOption.url, {
        allowPrivateRelay: this.options.allowPrivateRelay,
      });
    const relay = transport(relayOption, this.options.owner),
      owner = this.options.owner,
      inbox =
        typeof relayOption === 'string'
          ? recipientInbox(this, relay, owner.did, relayOption.replace(/\/$/, ''))
          : recipientInbox(relayOption, relay, owner.did);
    const cards = !invite && relay.discover ? await relay.discover() : [];
    if (cards.some((c) => !verifySignedAgentCard(c))) throw new Error('INVALID_AGENT_CARD');
    const card = cards.find(
      (c) => c.payload.agentDid === options.to || c.payload.ownerDid === options.to,
    );
    const peer = invite?.ownerDid ?? card?.payload.ownerDid ?? options.to;
    if (peer === owner.did) throw new Error('DISTINCT_OWNERS_REQUIRED');
    const manifest =
      options.manifest ??
      buildTaskManifest({
        ...options,
        ownerDid: owner.did,
        workerDid: peer,
        agentDid: invite?.agentDid ?? card?.payload.agentDid ?? peer,
      });
    validateManifest(manifest);
    if (
      manifest.requester.ownerDid !== owner.did ||
      manifest.worker?.ownerDid !== peer ||
      Date.parse(manifest.deadline) <= Date.now()
    )
      throw new Error('INVALID_MANIFEST_PARTIES_OR_DEADLINE');
    if (options.minimumIsolationLevel) {
      manifest.sandboxPolicy = {
        ...manifest.sandboxPolicy,
        isolationLevel: options.minimumIsolationLevel,
      };
      if (options.minimumIsolationLevel === 'oci_container')
        manifest.verification = { ...manifest.verification, requireExecutionAttestation: true };
    }
    if (!validateOutput(manifest.io.inputSchema, options.input)) throw new Error('INPUT_SCHEMA');
    const auditPath = options.auditPath ?? this.options.auditPath;
    freshAudit(auditPath);
    const bridge = new AbortController();
    const signal = sessionSignal(
      Math.min(this.options.timeoutMs ?? 120000, Date.parse(manifest.deadline) - Date.now()),
      bridge.signal,
    );
    const mailbox = inbox.attach(manifest.taskId);
    const wire = new SessionWire(
      mailboxRelay(relay, mailbox),
      owner,
      peer,
      manifest.taskId,
      [owner.did, peer],
      signal,
      auditPath,
    );
    if (onProgress) {
      wire.onProgress = async (progress, envelope) => {
        await onProgress(progress, {
          taskId: envelope.payload.taskId,
          seq: envelope.payload.seq,
          eventType: envelope.payload.eventType,
          senderDid: envelope.payload.senderDid,
          recipientDid: envelope.payload.recipientDid,
          payload: progress,
        });
      };
    }
    let gateway: OwnerGateway | undefined;
    let deferredCancel = false;
    let cancelStarted = false;
    const startCancel = () => {
      if (cancelStarted || !gateway) return;
      const state = gateway.machine.state;
      if (state !== 'ACCEPTED' && state !== 'IN_PROGRESS') return;
      cancelStarted = true;
      const transition = gateway.transition('CANCEL');
      void wire
        .cancelSession({
          reason: String(options.signal?.reason ?? 'cancelled'),
          cancelledBy: owner.did,
          transition,
        })
        .catch(() => undefined);
    };
    const onUserAbort = () => {
      const state = gateway?.machine.state;
      if (state === 'IN_PROGRESS') startCancel();
      else if (state === 'ACCEPTED') deferredCancel = true;
      else bridge.abort(options.signal?.reason);
    };
    options.signal?.addEventListener('abort', onUserAbort);
    if (options.signal?.aborted) onUserAbort();
    try {
      const capabilityChains = manifest.permissions.grantedCapabilities.map((g) => {
        const root = createCapability(
          {
            audience: owner.did,
            taskId: manifest.taskId,
            resource: g.resource,
            allowedTools: g.allowedTools,
            argConstraints: Object.fromEntries(
              g.allowedTools.map((t) => [t, g.argConstraints ?? { type: 'object' }]),
            ),
            maxCalls: g.maxInvocations,
            notBefore: manifest.createdAt,
            expiresAt: g.expiresAt,
            maxDepth: 1,
          },
          owner,
        );
        const leaf = createCapability(
          { ...root.payload, audience: peer, maxDepth: 0 },
          owner,
          root,
        );
        return [root, leaf];
      });
      await wire.sendEvent('PROPOSE', {
        proposal: signPayload(manifest, owner),
        input: options.input,
        capabilityChains,
        ...(invite ? { inviteToken: options.to } : {}),
      });
      const accept = (await wire.receiveEvent('ACCEPT')).payload.payload as unknown as {
        contract: TaskContract;
        transition: Signed<Transition>;
        approval: import('@acp/core').ApprovalReceipt;
      };
      if (
        !verifyContract(accept.contract) ||
        digest(accept.contract.manifest) !== digest(manifest) ||
        !verifyApproval(
          accept.approval,
          peer,
          manifest.taskId,
          'contract_acceptance',
          accept.contract.contractDigest,
        )
      )
        throw new Error('INVALID_ACCEPTANCE');
      gateway = new OwnerGateway(owner, accept.contract, policy);
      gateway.machine.apply(accept.transition);
      gateway.machine.apply(
        (await wire.receiveEvent('START')).payload.payload as unknown as Signed<Transition>,
      );
      if (options.signal?.aborted || deferredCancel) startCancel();
      const envelope = await wire.receiveEvent('DELIVER'),
        data = envelope.payload.payload as unknown as Delivery & { transition: Signed<Transition> };
      gateway.machine.apply(data.transition);
      const approval = () =>
        this.approvalProvider.approve({
          taskId: manifest.taskId,
          gate: 'final_verification',
          target: data,
          details: { manifest, deliverableDigest: data.artifact.payload.digest },
          signal,
        });
      const { result, verification, settlement } = await gateway.verifyAndSettle(
        wire.sealed(envelope),
        this.options.verificationEngine ?? new VerificationEngine(),
        approval,
      );
      if (!result.accepted || !settlement) {
        await wire.sendEvent('VERIFY_REJECT', verification);
        throw new Error('VERIFICATION_REJECTED: ' + result.reason);
      }
      await wire.sendEvent('VERIFY_ACCEPT', verification);
      await wire.sendEvent('SETTLED', settlement);
      return {
        taskId: manifest.taskId,
        state: 'SETTLED',
        deliverable: data.artifact.payload.data,
        bundle: await wire.finishRequester(),
        verification: result,
      };
    } catch (e) {
      if (cancelStarted) {
        try {
          await wire.cancelSession();
          const bundle = await wire.finishRequester();
          throw Object.assign(new Error('CANCELLED'), { bundle });
        } catch (inner) {
          if (inner instanceof Error && inner.message === 'CANCELLED') throw inner;
          await wire.rawSend('ERROR', { code: safeError(inner) }).catch(() => {});
          throw inner;
        }
      }
      await wire.rawSend('ERROR', { code: safeError(e) }).catch(() => {});
      throw e;
    } finally {
      options.signal?.removeEventListener('abort', onUserAbort);
      inbox.detach(manifest.taskId);
      gateway?.close();
    }
  }
  async delegateMulti(options: DelegateMultiOptions): Promise<DelegateMultiResult> {
    if (!Array.isArray(options.workers) || options.workers.length === 0)
      throw new Error('WORKERS_REQUIRED');
    if (options.mode !== 'race' && options.mode !== 'quorum')
      throw new Error('INVALID_DELEGATION_MODE');
    const count = options.workers.length;
    const quorumSize = options.quorumSize ?? Math.floor(count / 2) + 1;
    if (
      options.mode === 'quorum' &&
      (!Number.isInteger(quorumSize) || quorumSize < 1 || quorumSize > count)
    )
      throw new Error('INVALID_QUORUM_SIZE');
    const resolved = options.workers.map((worker) =>
      resolveWorkerTarget(worker, this.options.allowPrivateRelay),
    );
    await canonicalizeDiscoveredWorkers(resolved, {
      relay: this.options.relay,
      owner: this.options.owner,
    });
    const seenWorkers = new Set<string>();
    for (const worker of resolved) {
      if (seenWorkers.has(worker.workerDid)) throw new Error('DUPLICATE_WORKER_TARGET');
      seenWorkers.add(worker.workerDid);
    }
    const controllers = options.workers.map(() => new AbortController());
    const finished = options.workers.map(() => false);
    const receipts: DelegateReceipt[] = [];
    let failures = 0;
    let winnerDigest: string | undefined;
    const abortUnfinished = (reason: string) => {
      controllers.forEach((controller, index) => {
        if (!finished[index]) controller.abort(reason);
      });
    };
    const jobs = resolved.map(async (worker, index) => {
      const signal = options.signal
        ? AbortSignal.any([options.signal, controllers[index].signal])
        : controllers[index].signal;
      try {
        const result = await this.delegate({
          to: worker.inviteToken ?? worker.workerDid,
          relay: worker.relayUrl ?? this.options.relay,
          title: options.title,
          description: options.description,
          input: options.input,
          outputSchema: options.outputSchema,
          budget: options.budget,
          capabilities: options.capabilities,
          minimumIsolationLevel: options.minimumIsolationLevel,
          signal,
          onProgress: options.onProgress,
          auditPath: options.auditPath
            ? options.auditPath.replace(/(\.jsonl)?$/, '.' + index + '.jsonl')
            : undefined,
        });
        finished[index] = true;
        // SETTLED always carries a verified deliverable, including JSON null.
        if (result.state !== 'SETTLED') throw new Error('VERIFICATION_REJECTED');
        const workerDid = verifiedWorkerDid(result.bundle, worker.workerDid);
        const outputDigest = digest(result.deliverable);
        receipts.push({
          workerDid,
          taskId: result.taskId,
          outputDigest,
          deliverable: result.deliverable,
          bundle: result.bundle,
          accepted: true,
        });
        if (options.mode === 'quorum' && !winnerDigest) {
          const distinct = new Set(
            receipts
              .filter((receipt) => receipt.outputDigest === outputDigest)
              .map((receipt) => receipt.workerDid),
          );
          if (distinct.size >= quorumSize) {
            winnerDigest = outputDigest;
            abortUnfinished('QUORUM_REACHED');
          }
        }
        return { index, result, outputDigest, workerDid };
      } catch (error) {
        finished[index] = true;
        failures += 1;
        if (options.mode === 'quorum' && !winnerDigest && failures > count - quorumSize)
          abortUnfinished('QUORUM_UNREACHABLE');
        throw error;
      }
    });
    if (options.mode === 'race') {
      let winner: { index: number; result: SessionResult; outputDigest: string; workerDid: string };
      try {
        winner = await Promise.any(jobs);
      } catch {
        throw new Error('RACE_FAILED');
      }
      abortUnfinished('RACE_LOST');
      await Promise.allSettled(jobs);
      const outputDigest = winner.outputDigest;
      return {
        mode: 'race',
        status: 'SETTLED',
        deliverable: winner.result.deliverable as Json,
        outputDigest,
        taskIds: receipts.map((receipt) => receipt.taskId),
        winners: [
          {
            workerDid: winner.workerDid,
            taskId: winner.result.taskId,
            outputDigest,
          },
        ],
        receipts,
        cancelled: resolved
          .filter((_, index) => index !== winner.index && controllers[index].signal.aborted)
          .map((worker) => worker.workerDid),
      };
    }
    await Promise.allSettled(jobs);
    if (!winnerDigest) throw Object.assign(new Error('QUORUM_NOT_REACHED'), { receipts });
    const seenWinners = new Set<string>();
    const winners = receipts.filter((receipt) => {
      if (receipt.outputDigest !== winnerDigest || seenWinners.has(receipt.workerDid)) return false;
      seenWinners.add(receipt.workerDid);
      return true;
    });
    return {
      mode: 'quorum',
      status: 'SETTLED',
      deliverable: winners[0].deliverable,
      outputDigest: winnerDigest,
      taskIds: receipts.map((receipt) => receipt.taskId),
      winners: winners.map((receipt) => ({
        workerDid: receipt.workerDid,
        taskId: receipt.taskId,
        outputDigest: receipt.outputDigest,
      })),
      receipts,
      cancelled: resolved
        .filter((_, index) => controllers[index].signal.aborted)
        .map((worker) => worker.workerDid),
    };
  }
}
function canonicalInviteToken(token: string | Signed<Invite>): string {
  if (typeof token === 'string') return token;
  return 'acp-invite:' + Buffer.from(JSON.stringify(token)).toString('base64url');
}
function resolveWorkerTarget(
  target: DelegateWorkerTarget,
  allowPrivateRelay?: boolean,
): DelegateWorkerTarget & { inviteToken?: string } {
  let workerDid = target.workerDid;
  let inviteToken: string | undefined;
  if (target.inviteToken !== undefined && target.inviteToken !== '') {
    inviteToken = canonicalInviteToken(target.inviteToken);
    const invite = parseAndVerifyInviteToken(inviteToken, Date.now(), { allowPrivateRelay });
    const verified = invite.agentCard.payload.agentDid;
    if (verified !== invite.agentDid) throw new Error('WORKER_DID_MISMATCH');
    if (workerDid && workerDid !== verified) throw new Error('WORKER_DID_MISMATCH');
    workerDid = verified;
  } else {
    if (typeof workerDid !== 'string' || workerDid.length === 0) throw new Error('INVALID_DID');
    resolveDid(workerDid);
  }
  return { workerDid, inviteToken, relayUrl: target.relayUrl };
}
function verifiedWorkerDid(bundle: AuditBundle, expectedDid: string): string {
  if (!verifyAudit(bundle).valid) throw new Error('VERIFICATION_REJECTED');
  const accept = bundle.entries.find((entry) => entry.body.eventType === 'ACCEPT');
  const payload = accept?.body.payload;
  const worker =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { contract?: { manifest?: TaskManifest } }).contract?.manifest?.worker
      : undefined;
  const actors = bundle.checkpoint.actor.payload.actors;
  if (
    !worker ||
    (worker.agentDid !== expectedDid && worker.ownerDid !== expectedDid) ||
    !actors.includes(worker.ownerDid) ||
    !verifySigned(bundle.checkpoint.actor, actors[0])
  )
    throw new Error('WORKER_DID_MISMATCH');
  // Receipts and quorum use the card's agentDid, even when the caller addressed the owner DID.
  return worker.agentDid;
}
async function canonicalizeDiscoveredWorkers(
  targets: Array<{ workerDid: string; inviteToken?: string; relayUrl?: string }>,
  options: { relay?: RelayTransport | string; owner: KeyPair },
): Promise<void> {
  const pending = targets.filter((target) => !target.inviteToken);
  if (pending.length === 0) return;
  const relays = new Map<RelayTransport | string, typeof pending>();
  for (const target of pending) {
    const relay = target.relayUrl ?? options.relay;
    if (!relay) continue;
    const group = relays.get(relay) ?? [];
    group.push(target);
    relays.set(relay, group);
  }
  await Promise.all(
    [...relays.entries()].map(async ([relayOption, group]) => {
      try {
        const relay = transport(relayOption, options.owner);
        if (!relay.discover) return;
        const cards = await relay.discover();
        if (!Array.isArray(cards) || cards.some((card) => !verifySignedAgentCard(card))) return;
        for (const target of group) {
          const card = cards.find(
            (item) =>
              item.payload.agentDid === target.workerDid ||
              item.payload.ownerDid === target.workerDid,
          );
          if (card) target.workerDid = card.payload.agentDid;
        }
      } catch {
        // Discovery only collapses aliases. Settlement still checks the signed manifest.
      }
    }),
  );
}
export function buildTaskManifest(options: {
  ownerDid: string;
  workerDid: string;
  agentDid?: string;
  title: string;
  description: string;
  outputSchema?: Schema;
  budget?: Partial<BudgetSpec>;
  capabilities?: TaskManifest['permissions']['grantedCapabilities'];
}): TaskManifest {
  const createdAt = new Date().toISOString(),
    deadline = new Date(Date.now() + 600000).toISOString();
  return {
    protocolVersion: '0.1.0',
    taskId: 'task_' + randomUUID().replaceAll('-', ''),
    createdAt,
    deadline,
    requester: { ownerDid: options.ownerDid, agentDid: options.ownerDid },
    worker: { ownerDid: options.workerDid, agentDid: options.agentDid ?? options.workerDid },
    task: {
      title: options.title,
      description: options.description,
      acceptanceCriteria: [
        { id: 'ac_schema', description: 'Output satisfies the agreed JSON schema', required: true },
      ],
    },
    io: { inputSchema: {}, outputSchema: options.outputSchema ?? {} },
    verification: {
      mode: 'hybrid',
      requireUsageReceipt: true,
      requireExecutionAttestation: true,
      maxRetries: 0,
    },
    budget: {
      costBearer: 'worker_byok',
      maxInputTokens: 50000,
      maxOutputTokens: 10000,
      maxToolInvocations: 10,
      maxWallClockSeconds: 60,
      onOverrun: 'hard_stop',
      ...options.budget,
    },
    permissions: { maxDelegationDepth: 0, grantedCapabilities: options.capabilities ?? [] },
    sandboxPolicy: {
      isolationLevel: 'subprocess_restricted',
      networkAccess: 'none',
      filesystemScope: 'ephemeral_workspace_only',
    },
    hitlPolicy: { requiredGates: ['GATE_CONTRACT_ACCEPT', 'GATE_DELIVERY_ACCEPT'] },
  };
}
