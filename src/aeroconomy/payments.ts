import { z } from 'zod';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';
import { isAccountNumber } from './banking.js';
import { AEROCONOMY_API, AeroconomyError } from './http.js';

/**
 * The one place the bot sends money: `POST /api/v1/banking/payments`, Aeroconomy's itemised payment. Everything else the bot does with Aeroconomy is a read
 * (see `AeroHttp`); this is a separate class so that a reader of the code can see where a write is possible, and so that nothing which only reads can pay.
 *
 * How Aeroconomy takes a payment (its public API documentation): `Authorization: Bearer <the token>`, a required `Idempotency-Key` header that is
 * kept for 24 hours (sending the same payment again with the same key and the same details is answered with the original 201, marked
 * `Idempotent-Replayed: true`, and sends nothing more; the same key with different details is a 409), and a body of the source account, the
 * recipient account, a description and the lines, whose amounts add up to the payment. It is atomic: the answer is 201, or nothing moved.
 * 401 is a token it does not accept, 403 an account the token's user does not control, 422 an account that does not exist or not enough money.
 *
 * What this adds, because money is involved:
 *  - Everything is checked before anything is sent: the two accounts are account numbers (and different), the amount is a whole number of cents
 *    above nothing, the key is plain.
 *  - It talks to one fixed address, never follows a redirect (so the token can never be sent anywhere else), never reads more than a little of an
 *    answer, and gives up on a request after thirty seconds.
 *  - A request that may have been processed without the answer arriving (the network dropped, a timeout, a server error) is sent again with the
 *    SAME key, which Aeroconomy answers with the original result if it had been processed, so it can neither be lost nor made twice. If it still
 *    has no answer after that, this throws: nobody knows whether the money moved, and the caller must not treat it as paid or as refused.
 *  - A good answer is checked against what was asked: a payment of another amount, or to another account, is not taken as the payment that was
 *    made. It throws too, for a person to look at.
 *  - The token is held for the life of the object, only ever put in the `Authorization` header, and never logged. Account numbers are logged only
 *    by their last four characters.
 */

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 200_000;
/** Tries at one payment (the first, and sends again with the same key). */
const MAX_ATTEMPTS = 3;
/** The key is made of these, and is this long at most. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{3,120}$/;

export interface PaymentRequest {
  /** Makes sending the same payment twice harmless. Every different payment needs a different one. */
  idempotencyKey: string;
  sourceAccount: string;
  recipientAccount: string;
  /** What the payment is for. */
  description: string;
  /** The amount, in cents. */
  cents: number;
}

export type PaymentOutcome =
  /** Aeroconomy took the payment (or took it before, if `replayed`). */
  | { ok: true; transactionId: number | null; replayed: boolean; /** The source account's balance after the payment, in cents, when Aeroconomy said. */ balanceCents: number | null }
  /** Aeroconomy refused: nothing moved. `reason` is safe to show. */
  | { ok: false; status: number; reason: string };

export interface PaymentsClientOptions {
  fetchFn?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
  baseUrl?: string;
  /** Waits between tries. Tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
}

const Account = z.preprocess((v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined), z.object({ account_number: z.string().nullish() }).passthrough().optional());
const Answer = z
  .object({
    data: z.preprocess(
      (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined),
      z.object({ id: z.number().int().nullish(), total_amount: z.union([z.string(), z.number()]).nullish(), sender: Account, recipient: Account }).passthrough().optional(),
    ),
    meta: z.preprocess((v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined), z.object({ balance: z.union([z.string(), z.number()]).nullish() }).passthrough().optional()),
  })
  .passthrough();

const ErrorBody = z
  .object({ message: z.string().nullish(), errors: z.record(z.string(), z.unknown()).nullish() })
  .passthrough();

/** `1250.00` as Aeroconomy writes an amount, or the number it is in cents; null when it is neither. */
const centsOf = (v: string | number | null | undefined): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) < 1e10 ? Math.round(n * 100) : null;
};

/** Text from an answer that is safe to show: no control characters, one line, short. */
const safeText = (s: string, max = 160): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const last4 = (account: string): string => `…${account.slice(-4)}`;

/** The dollars of an amount in cents, the way Aeroconomy writes it: `1250.00`. */
export const amountText = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

export class AeroconomyPaymentsClient {
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;
  private readonly userAgent: string;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly token: string,
    opts: PaymentsClientOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.logger ?? silentLogger;
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
    this.base = (opts.baseUrl ?? AEROCONOMY_API).replace(/\/+$/, '');
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Send one payment. Resolves with Aeroconomy's answer: taken, or refused (nothing moved). Throws `AeroconomyError` when it cannot be known whether the
   * money moved (see above): the caller must leave the payment as "sent, no answer" and not send it again under another key.
   */
  async pay(p: PaymentRequest): Promise<PaymentOutcome> {
    const bad = this.problem(p);
    if (bad) return { ok: false, status: 0, reason: bad };
    const body = JSON.stringify({
      source_account_number: p.sourceAccount,
      recipient_account_number: p.recipientAccount,
      description: safeText(p.description, 120),
      lines: [{ description: safeText(p.description, 120), amount: amountText(p.cents) }],
    });
    const what = `${last4(p.sourceAccount)} to ${last4(p.recipientAccount)}`;

    // Set once a try has gone without a clear answer (no reply, or a server error): from then on a refusal no longer means nothing moved.
    let unanswered = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}/banking/payments`, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': p.idempotencyKey,
            'user-agent': this.userAgent,
            authorization: `Bearer ${this.token}`,
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        // It may have been processed with the answer lost on the way: send it again with the same key, which is safe either way.
        unanswered = true;
        if (attempt < MAX_ATTEMPTS) {
          this.log.debug(`A payment (${what}) got no answer (${e instanceof Error ? e.name : 'error'}); sending it again with the same key`);
          await this.sleep(2000 * attempt);
          continue;
        }
        throw new AeroconomyError('Aeroconomy gave no answer to the payment, so nobody knows whether the money moved.');
      }

      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        const asked = Number(res.headers.get('retry-after'));
        const seconds = Math.min(60, Number.isFinite(asked) && asked > 0 ? asked : 10 * attempt);
        if (attempt < MAX_ATTEMPTS) {
          this.log.debug(`Aeroconomy said slow down on a payment (${what}); waiting ${seconds} seconds`);
          await this.sleep(seconds * 1000);
          continue;
        }
        if (unanswered) throw new AeroconomyError('Aeroconomy never answered an earlier try and then asked me to slow down, so nobody knows whether the money moved.', 429);
        return { ok: false, status: 429, reason: 'Aeroconomy asked me to slow down, and still did after waiting. Nothing was sent.' };
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        unanswered = true;
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(2000 * attempt);
          continue;
        }
        throw new AeroconomyError(`Aeroconomy answered ${res.status} to the payment, so nobody knows whether the money moved.`, res.status);
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new AeroconomyError('Aeroconomy answered the payment with a redirect, which I do not follow, so nobody knows whether the money moved.', res.status);
      }

      const text = await readTextCapped(res, MAX_BODY_BYTES).catch(() => null);
      if (res.status === 200 || res.status === 201) return this.taken(res, text, p, what);
      if (unanswered) throw new AeroconomyError(`Aeroconomy never answered an earlier try and answered ${res.status} to the next, so nobody knows whether the money moved.`, res.status);
      return { ok: false, status: res.status, reason: this.refusal(res.status, text) };
    }
  }

  /** Why this request cannot be sent, or null. Checked before anything leaves. */
  private problem(p: PaymentRequest): string | null {
    if (!KEY_PATTERN.test(p.idempotencyKey)) return 'The payment has no usable ID, so it was not sent.';
    if (!isAccountNumber(p.sourceAccount) || !isAccountNumber(p.recipientAccount)) return 'One of the accounts is not an account number, so the payment was not sent.';
    if (p.sourceAccount === p.recipientAccount) return 'The payment would go from an account to itself, so it was not sent.';
    if (!Number.isInteger(p.cents) || p.cents <= 0 || p.cents > 99_999_999_999) return 'The amount is not an amount that can be paid, so the payment was not sent.';
    if (safeText(p.description, 120) === '') return 'The payment has no description, so it was not sent.';
    return null;
  }

  /** A 200 or 201: check it is the payment that was asked for, then say so. */
  private taken(res: Response, text: string | null, p: PaymentRequest, what: string): PaymentOutcome {
    let json: unknown;
    try {
      json = text === null ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    const answer = Answer.safeParse(json);
    if (!answer.success) throw new AeroconomyError('Aeroconomy accepted the payment but sent an answer I do not understand, so I cannot confirm it.', res.status);
    const data = answer.data.data;
    if (!data) throw new AeroconomyError('Aeroconomy accepted the payment but did not say what it was, so I cannot confirm it.', res.status);
    const total = centsOf(data.total_amount);
    if (total !== null && total !== p.cents) throw new AeroconomyError('Aeroconomy answered with a different amount from the one I sent, so I cannot confirm the payment.', res.status);
    const to = data.recipient?.account_number;
    if (to && to !== p.recipientAccount) throw new AeroconomyError('Aeroconomy answered with a different recipient from the one I sent, so I cannot confirm the payment.', res.status);
    const replayed = (res.headers.get('idempotent-replayed') ?? '').toLowerCase() === 'true';
    this.log.info(`Aeroconomy took a payment (${what})${replayed ? ' (it had been taken before)' : ''}`);
    return { ok: true, transactionId: data.id ?? null, replayed, balanceCents: centsOf(answer.data.meta?.balance) };
  }

  /** What an answer that is not a success says, in words that are safe to show. Nothing moved. */
  private refusal(status: number, text: string | null): string {
    let said = '';
    try {
      const body = ErrorBody.safeParse(text === null ? null : JSON.parse(text));
      if (body.success) {
        const first = Object.values(body.data.errors ?? {})
          .flatMap((v) => (Array.isArray(v) ? v : [v]))
          .find((v) => typeof v === 'string');
        said = safeText(typeof first === 'string' ? first : (body.data.message ?? ''));
      }
    } catch {
      said = '';
    }
    const generic: Record<number, string> = {
      401: 'Aeroconomy did not accept the FsHub token, so it could not send the payment.',
      403: "The account the FsHub token belongs to doesn't control the account the money comes from, so Aeroconomy would not send it.",
      404: 'Aeroconomy could not find the payment service.',
      409: 'Aeroconomy already has a payment under this ID with different details, so it sent nothing.',
      422: 'Aeroconomy refused the payment (an account it does not know, or not enough money).',
    };
    const base = generic[status] ?? `Aeroconomy refused the payment (${status}).`;
    return said && !base.includes(said) ? `${base} It said: ${said}` : base;
  }
}
