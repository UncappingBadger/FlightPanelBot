import type { AeroconomyPaymentsClient } from '../aeroconomy/payments.js';
import { MAX_PAYMENT_CENTS } from './payroll.js';

/**
 * The one place money leaves the airline's account. Everything else in paying pilots (reading the sheet, working out the list, the admin
 * checking it, the ledger that keeps a payment from being made twice) is done without it; this is only "send this much from that account to
 * that one, under this unique ID".
 *
 * `AeroconomyGateway` is the real one: it sends the payment to Aeroconomy with the unique ID as the payment's idempotency key. Where the bot has
 * no FsHub token to send it with, `NotConnectedGateway` stands in, says so, and `Payroll` never records a payment as made.
 */

export interface PayRequest {
  /** The airline's account the money comes from. */
  sourceAccount: string;
  /** The pilot's account. */
  recipientAccount: string;
  /** The payment's unique ID. It is also what makes sending the same payment twice harmless at the bank (its idempotency key). */
  uniqueId: string;
  /** The amount in cents. */
  cents: number;
  /** What the payment says it is for. */
  description: string;
}

export type PayResult =
  /** The bank took the payment. `reference` is its own number for it, when it gave one, and `balanceCents` what the source account then held, when it said. */
  | { ok: true; reference: string | null; balanceCents?: number | null }
  /** The bank said no (not enough money, no such account...): nothing was sent. */
  | { ok: false; reason: string };

export interface PaymentGateway {
  /** False while no bank connection is set up: nothing can be paid, and the Pay button says so instead of trying. */
  readonly connected: boolean;
  /**
   * Send one payment. Resolves with the bank's answer. If it throws, nobody knows whether the money moved, and the payment is left marked as
   * being sent rather than tried again.
   */
  pay(request: PayRequest): Promise<PayResult>;
}

/** The text shown while there is no bank connection. */
export const NOT_CONNECTED_TEXT = "Paying isn't connected to Aeroconomy yet: the bot has no access to the airline's bank account. Nothing was sent, nothing was recorded as paid, and the list is still here.";

export class NotConnectedGateway implements PaymentGateway {
  readonly connected = false;
  async pay(): Promise<PayResult> {
    return { ok: false, reason: NOT_CONNECTED_TEXT };
  }
}

/**
 * The bank connection: Aeroconomy's itemised payment (`POST /banking/payments`), sent with the payment's unique ID as its idempotency key, so a
 * payment sent twice is taken once. The money comes from the account the FsHub token's user controls. A refusal is "nothing was sent"; no answer at
 * all is an error that the caller leaves as "sent, no answer" and never tries again by itself (see `AeroconomyPaymentsClient.pay`).
 */
export class AeroconomyGateway implements PaymentGateway {
  readonly connected = true;

  constructor(private readonly client: Pick<AeroconomyPaymentsClient, 'pay'>) {}

  async pay(request: PayRequest): Promise<PayResult> {
    if (!Number.isInteger(request.cents) || request.cents <= 0 || request.cents > MAX_PAYMENT_CENTS) {
      return { ok: false, reason: 'That amount is not one the bot will send, so nothing was sent.' };
    }
    const out = await this.client.pay({
      idempotencyKey: request.uniqueId,
      sourceAccount: request.sourceAccount,
      recipientAccount: request.recipientAccount,
      description: request.description,
      cents: request.cents,
    });
    if (!out.ok) return { ok: false, reason: out.reason };
    return { ok: true, reference: out.transactionId === null ? null : String(out.transactionId), balanceCents: out.balanceCents };
  }
}

