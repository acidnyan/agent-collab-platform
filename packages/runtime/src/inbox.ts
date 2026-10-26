// SPDX-License-Identifier: Apache-2.0
import { verifyEnvelope } from '@acp/core';
import type { SignedEnvelope } from '@acp/core';
/** Gateway-owned replay defense, independent of any relay behavior. */
export class EnvelopeInbox {
  #next = 0;
  constructor(
    readonly recipientDid: string,
    readonly senderDid: string,
    readonly taskId: string,
  ) {}
  receive(envelope: SignedEnvelope): SignedEnvelope {
    if (
      !verifyEnvelope(envelope, this.recipientDid) ||
      envelope.payload.senderDid !== this.senderDid ||
      envelope.payload.taskId !== this.taskId ||
      envelope.payload.seq !== this.#next
    )
      throw new Error('INVALID_OR_REPLAYED_ENVELOPE');
    this.#next++;
    return structuredClone(envelope);
  }
}
