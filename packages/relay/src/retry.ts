// SPDX-License-Identifier: Apache-2.0
export class RelayTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor() { super('RELAY_REQUEST_TIMEOUT'); this.name = 'RelayTimeoutError'; }
}

export function isTransientRelayError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return error.name === 'TimeoutError' || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code ?? '') ||
    /^socket hang up$/i.test(error.message) ||
    /^RELAY_(?:REGISTRATION_)?REJECTED:\s*(429|502|503|504)\b/.test(error.message) ||
    (error.cause !== undefined && error.cause !== error && isTransientRelayError(error.cause));
}

export function relayRetryDelay(attempt: number): number {
  return Math.round(Math.min(30_000, 250 * 2 ** Math.min(attempt, 7)) * (0.5 + Math.random() * 0.5));
}

export function waitForRelayRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('SESSION_ABORTED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Bound even injected transports/resolvers that do not honor cancellation. */
export async function relayDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RelayTimeoutError()), ms);
    })]);
  } finally { clearTimeout(timer); }
}
