// SPDX-License-Identifier: Apache-2.0
import { signUsage, verifySigned, validateSchema, verifyApproval, digest } from '@acp/core';
import type { BudgetSpec, KeyPair, Usage, UsageReceipt, ApprovalReceipt } from '@acp/core';
export function usageWithinBudget(usage: Usage, budget: BudgetSpec): boolean {
  return [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.toolCalls, usage.wallTimeMs].every(n => Number.isSafeInteger(n) && n >= 0) && usage.totalTokens === usage.inputTokens + usage.outputTokens && !usage.halted && usage.inputTokens <= budget.maxInputTokens && usage.outputTokens <= budget.maxOutputTokens && usage.toolCalls <= budget.maxToolInvocations && usage.wallTimeMs <= budget.maxWallClockSeconds * 1000;
}
export function verifyUsage(receipt: UsageReceipt, signerDid: string, taskId: string, budget: BudgetSpec): boolean { try { validateSchema('usage-receipt', receipt); return verifySigned(receipt, signerDid) && receipt.payload.taskId === taskId && usageWithinBudget(receipt.payload, budget); } catch { return false; } }
export class QuotaMeter {
  readonly controller = new AbortController();
  #usage: Usage; #budget: BudgetSpec; #started: number; #timer: ReturnType<typeof setTimeout>; #amendments = new Set<string>();
  get budget(): BudgetSpec { return structuredClone(this.#budget); }
  constructor(readonly taskId: string, budget: BudgetSpec, readonly ownerDid: string, readonly clock: () => number = Date.now) {
    this.#budget = structuredClone(budget); this.#started = clock();
    this.#usage = { type: 'UsageReceipt', taskId, inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, wallTimeMs: 0, halted: false };
    this.#timer = this.timer();
  }
  private timer() { const timer = setTimeout(() => this.halt('wallTimeMs'), Math.max(1, this.#budget.maxWallClockSeconds * 1000 - (this.clock() - this.#started))); timer.unref(); return timer; }
  private halt(reason: string): void { this.#usage.halted = true; this.controller.abort('BUDGET_EXCEEDED: ' + reason); }
  record(inputTokens = 0, outputTokens = 0, toolCalls = 0): void {
    if (![inputTokens, outputTokens, toolCalls].every(n => Number.isSafeInteger(n) && n >= 0)) { this.halt('invalid usage'); throw new Error('INVALID_USAGE'); }
    if (this.#usage.halted) throw new Error('BUDGET_EXCEEDED: halted');
    this.#usage.inputTokens += inputTokens; this.#usage.outputTokens += outputTokens; this.#usage.totalTokens = this.#usage.inputTokens + this.#usage.outputTokens; this.#usage.toolCalls += toolCalls; this.#usage.wallTimeMs = Math.max(0, this.clock() - this.#started);
    if (!usageWithinBudget(this.#usage, this.#budget)) { this.halt('quota'); throw new Error('BUDGET_EXCEEDED'); }
  }
  amendmentTarget(budget: BudgetSpec) { return { taskId: this.taskId, previousBudgetDigest: digest(this.#budget), budget }; }
  amend(budget: BudgetSpec, approval: ApprovalReceipt): void {
    if (this.#budget.onOverrun !== 'request_hitl_amendment' || !verifyApproval(approval, this.ownerDid, this.taskId, 'budget_increase', this.amendmentTarget(budget)) || this.#amendments.has(approval.payload.receiptId) || this.#usage.halted) throw new Error('BUDGET_APPROVAL_REQUIRED');
    if (![budget.maxInputTokens, budget.maxOutputTokens, budget.maxToolInvocations, budget.maxWallClockSeconds].every(n => Number.isSafeInteger(n) && n >= 0) || budget.maxWallClockSeconds < 1) throw new Error('INVALID_BUDGET');
    this.#amendments.add(approval.payload.receiptId); this.#budget = structuredClone(budget); clearTimeout(this.#timer); this.#timer = this.timer(); this.record();
  }
  receipt(key: KeyPair): UsageReceipt { if (key.did !== this.ownerDid) throw new Error('USAGE_SIGNER'); try { this.record(); } catch { /* Preserve exceeded totals in the signed receipt. */ } return signUsage(this.#usage, key); }
  close(): void { clearTimeout(this.#timer); }
}

/** Instrument the owner's provider adapter, before forwarding any stream output.
 * The adapter owns its BYOK credential; neither the credential nor provider SDK
 * enters the worker. Usage deltas must come from that trusted adapter.
 */
export async function* meteredProvider<T>(meter: QuotaMeter, stream: AsyncIterable<{ value: T; inputTokens: number; outputTokens: number }>): AsyncGenerator<T> {
  for await (const chunk of stream) { meter.record(chunk.inputTokens, chunk.outputTokens); yield chunk.value; }
}
