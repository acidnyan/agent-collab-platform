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
} from '@acp/core';
import type { AuditBundle } from '@acp/ledger';
import { HttpRelayClient } from '@acp/relay';
import type { RelayTransport } from '@acp/relay';
import type { AgentAdapter, AgentTaskContext } from './adapter.js';
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
  state: 'SETTLED';
  deliverable: Json;
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
function recipientInbox(source: object, relay: RelayTransport, did: string): RecipientInbox {
  let byDid = recipientInboxes.get(source);
  if (!byDid) {
    byDid = new Map();
    recipientInboxes.set(source, byDid);
  }
  let inbox = byDid.get(did);
  if (!inbox) {
    inbox = new RecipientInbox(relay, did);
    byDid.set(did, inbox);
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
  onEvent?: (event: string, taskId: string) => void;
}
interface Proposal {
  proposal: Signed<TaskManifest>;
  input: Json;
  capabilityChains: CapabilityToken[][];
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
    try {
      while (!idleSignal.aborted) {
        const incoming = receiveRelay(
          this.relay,
          this.options.owner.did,
          AbortSignal.any([idleSignal, wait.signal]),
        ).then(
          (envelope) => envelope,
          (error: unknown) => {
            if (idleSignal.aborted || wait.signal.aborted) return undefined;
            throw error;
          },
        );
        const envelope = await Promise.race([job.then(() => undefined), incoming]);
        if (!envelope) return;
        if (!this.deliver(envelope)) this.options.onEvent?.('REJECTED', '');
      }
    } finally {
      wait.abort();
    }
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
    const data = first.payload.payload as unknown as Proposal,
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
    let gateway: OwnerGateway | undefined, workspace: string | undefined;
    try {
      await wire.receiveEvent('PROPOSE', first);
      const contract = createContract(m, data.proposal, this.options.owner);
      const approval = await this.approvalProvider.approve({
        taskId: m.taskId,
        gate: 'contract_acceptance',
        target: contract.contractDigest,
        details: { manifest: m, capabilities: data.capabilityChains },
        signal: activeSignal,
      });
      gateway = new OwnerGateway(this.options.owner, contract, policy);
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
      const executionSignal = AbortSignal.any([activeSignal, gateway.quota.controller.signal]);
      let effectiveIsolationLevel = 'host_adapter';
      const context: AgentTaskContext = {
        taskId: m.taskId,
        manifest: structuredClone(m),
        input: structuredClone(data.input),
        workspaceDir: workspace,
        signal: executionSignal,
        reportUsage: (delta) => gateway!.quota.recordMetrics(delta),
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
      await wire.rawSend('ERROR', { code: safeError(e) }).catch(() => {});
      throw e;
    } finally {
      gateway?.close();
      if (workspace) await rm(workspace, { recursive: true, force: true });
    }
  }
}
function safeError(e: unknown): string {
  const s = String(e);
  return (
    ['BUDGET', 'CAPABILITY', 'APPROVAL', 'HITL', 'INVALID', 'VERIFICATION', 'SCHEMA', 'ABORT'].find(
      (code) => s.includes(code),
    ) ?? 'EXECUTION_FAILED'
  );
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
}
export class RequesterClient {
  readonly approvalProvider: ApprovalProvider;
  constructor(readonly options: RequesterClientOptions) {
    this.approvalProvider =
      options.approvalProvider ?? new InteractiveCliApprovalProvider(options.owner);
  }
  async delegate(options: DelegateOptions): Promise<SessionResult> {
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
      inbox = recipientInbox(
        typeof relayOption === 'string' ? this : relayOption,
        relay,
        owner.did,
      );
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
    if (!validateOutput(manifest.io.inputSchema, options.input)) throw new Error('INPUT_SCHEMA');
    const auditPath = options.auditPath ?? this.options.auditPath;
    freshAudit(auditPath);
    const signal = sessionSignal(
      Math.min(this.options.timeoutMs ?? 120000, Date.parse(manifest.deadline) - Date.now()),
      options.signal,
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
    let gateway: OwnerGateway | undefined;
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
        envelope,
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
      await wire.rawSend('ERROR', { code: safeError(e) }).catch(() => {});
      throw e;
    } finally {
      inbox.detach(manifest.taskId);
      gateway?.close();
    }
  }
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
