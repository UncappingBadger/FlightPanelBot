/**
 * The one place money leaves the airline's account. Everything else in paying pilots (reading the sheet, working out the list, the admin
 * checking it, the ledger that keeps a payment from being made twice) is done without it; this is only "send this much from that account to
 * that one, under this unique ID".
 *
 * Nothing real is behind it yet: Aeroconomy's payment interface needs a key that gives access to the airline's bank account, and the bot has
 * none. Until it has, `NotConnectedGateway` stands in, says so, and `Payroll` never records a payment as made.
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
  /** The bank took the payment. `reference` is its own number for it, when it gave one. */
  | { ok: true; reference: string | null }
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
