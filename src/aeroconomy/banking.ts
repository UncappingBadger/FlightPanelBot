import { z } from 'zod';
import { AeroHttp, AeroconomyError, type AeroHttpOptions } from './http.js';

/**
 * Read-only access to a person's Aeroconomy bank accounts: the accounts they can see (their own, their businesses', and ones shared with them) and each
 * account's payments. Aeroconomy asks for the person's own API token on every request, so this holds none: a token is handed in for each call, used for
 * that one request, and never kept, logged or put in an address.
 *
 * It only ever sends GET requests, only to Aeroconomy (a fixed address, redirects never followed), one at a time and slowly (see `AeroHttp`). Nothing can
 * be paid, moved or changed through it.
 */

/** An account a person can see. */
export interface BankAccount {
  /** The public account number, like `9954-0000123`. */
  number: string;
  name: string;
  /** Aeroconomy's own word for the kind (`personal`, `business`, ...), when it gives one. */
  type: string | null;
}

/** One side of a payment. */
export interface BankParty {
  number: string | null;
  name: string | null;
}

export interface BankLine {
  description: string | null;
  amount: number;
}

/** One payment in an account's list. */
export interface BankTransaction {
  /** Aeroconomy's transaction number: payments are listed newest first, and a newer one always has a higher number. */
  id: number;
  at: number | null;
  /** `debit` is money leaving the account it is listed under, `credit` money coming in; null if Aeroconomy said neither. */
  direction: 'debit' | 'credit' | null;
  description: string | null;
  /** The whole payment, in dollars. */
  amount: number;
  sender: BankParty | null;
  recipient: BankParty | null;
  lines: BankLine[];
}

export interface TransactionPage {
  /** Newest first, as Aeroconomy sends them. */
  transactions: BankTransaction[];
  /** More, older, payments exist after this page. */
  hasMore: boolean;
  /** Pass this as `beforeId` to get the next (older) page. */
  nextCursor: number | null;
}

const objectOrMissing = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined);

const ListPage = z.object({ data: z.array(z.unknown()).default([]) }).passthrough();

const AccountRow = z
  .object({
    account_number: z.string().min(1),
    account_name: z.string().nullish(),
    account_type: z.string().nullish(),
  })
  .passthrough();

const Party = z.preprocess(objectOrMissing, z.object({ account_number: z.string().nullish(), account_name: z.string().nullish() }).passthrough().optional());

const TransactionRow = z
  .object({
    id: z.number().int().positive(),
    created_at: z.string().nullish(),
    direction: z.string().nullish(),
    description: z.string().nullish(),
    total_amount: z.union([z.string(), z.number()]).nullish(),
    sender: Party,
    recipient: Party,
    lines: z.array(z.unknown()).nullish(),
  })
  .passthrough();

const LineRow = z.object({ description: z.string().nullish(), amount: z.union([z.string(), z.number()]).nullish() }).passthrough();

const Meta = z.preprocess(objectOrMissing, z.object({ has_more: z.boolean().nullish(), next_cursor: z.number().int().nullish() }).passthrough().optional());

/** Only the characters a bank account number is made of, so what Aeroconomy lists can never change where a request goes. */
const ACCOUNT_NUMBER = /^[0-9A-Za-z-]{3,40}$/;
export const isAccountNumber = (s: string): boolean => ACCOUNT_NUMBER.test(s);

const cleanText = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** An amount as Aeroconomy writes it (`1250.00`), or null when it is not one. */
function amountOf(v: string | number | null | undefined): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) < 1e12 ? Math.round(n * 100) / 100 : null;
}

const party = (p: { account_number?: string | null | undefined; account_name?: string | null | undefined } | undefined): BankParty | null => {
  if (!p) return null;
  const number = p.account_number && isAccountNumber(p.account_number) ? p.account_number : null;
  const name = cleanText(p.account_name, 80);
  return number === null && name === null ? null : { number, name };
};

export class AeroconomyBankingClient extends AeroHttp {
  constructor(opts: AeroHttpOptions = {}) {
    super(opts);
  }

  /** The accounts this token can see. An account that cannot be read is left out. Throws `AeroconomyError` (with `status` 401 when the token is not accepted). */
  async accounts(token: string): Promise<BankAccount[]> {
    const body = await this.fetchJson('/banking/accounts', token);
    if (body === null) return [];
    const page = ListPage.safeParse(body);
    if (!page.success) throw new AeroconomyError('Aeroconomy sent a list of accounts in a form I do not understand.');
    const out: BankAccount[] = [];
    for (const raw of page.data.data) {
      const row = AccountRow.safeParse(raw);
      if (!row.success || !isAccountNumber(row.data.account_number)) continue;
      if (out.some((a) => a.number === row.data.account_number)) continue;
      out.push({ number: row.data.account_number, name: cleanText(row.data.account_name, 80) ?? row.data.account_number, type: cleanText(row.data.account_type, 24) });
    }
    return out;
  }

  /**
   * One page of an account's payments, newest first (`limit` 1 to 100, `beforeId` for older ones). A payment that cannot be read is left out. An account
   * Aeroconomy does not show to this token is a 404 or 403, which throws an `AeroconomyError` with that `status`.
   */
  async transactions(token: string, account: string, opts: { limit?: number; beforeId?: number | null } = {}): Promise<TransactionPage> {
    if (!isAccountNumber(account)) throw new AeroconomyError('That is not a bank account number.', 404);
    const limit = Math.min(100, Math.max(1, Math.trunc(opts.limit ?? 25)));
    const before = opts.beforeId !== null && opts.beforeId !== undefined && Number.isSafeInteger(opts.beforeId) && opts.beforeId > 0 ? `&before_id=${opts.beforeId}` : '';
    const body = await this.fetchJson(`/banking/accounts/${encodeURIComponent(account)}/transactions?limit=${limit}${before}`, token);
    if (body === null) throw new AeroconomyError("Aeroconomy doesn't show that account to this token.", 404);
    const page = ListPage.safeParse(body);
    if (!page.success) throw new AeroconomyError('Aeroconomy sent a list of payments in a form I do not understand.');
    const meta = Meta.safeParse((body as { meta?: unknown }).meta);
    const transactions: BankTransaction[] = [];
    for (const raw of page.data.data) {
      const row = TransactionRow.safeParse(raw);
      if (!row.success) continue;
      const amount = amountOf(row.data.total_amount);
      if (amount === null) continue;
      const at = row.data.created_at ? Date.parse(row.data.created_at) : Number.NaN;
      const direction = row.data.direction === 'debit' || row.data.direction === 'credit' ? row.data.direction : null;
      const lines: BankLine[] = [];
      for (const l of row.data.lines ?? []) {
        const line = LineRow.safeParse(l);
        const a = line.success ? amountOf(line.data.amount) : null;
        if (line.success && a !== null) lines.push({ description: cleanText(line.data.description, 80), amount: a });
      }
      transactions.push({
        id: row.data.id,
        at: Number.isFinite(at) ? at : null,
        direction,
        description: cleanText(row.data.description, 120),
        amount,
        sender: party(row.data.sender),
        recipient: party(row.data.recipient),
        lines: lines.slice(0, 12),
      });
    }
    const m = meta.success ? meta.data : undefined;
    return { transactions, hasMore: m?.has_more === true, nextCursor: typeof m?.next_cursor === 'number' ? m.next_cursor : null };
  }
}
