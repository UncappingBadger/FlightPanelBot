import type { BankAccount } from '../aeroconomy/banking.js';
import type { PayRequest } from './payGateway.js';
import { cleanAccount } from './payroll.js';

/**
 * A test transfer: a small payment between two accounts the bot's FsHub token can see, so that an admin can prove the bank connection works (and
 * what it says) before any pilot is paid. It is only ever between two accounts in the list Aeroconomy gives for that token (the airline's own accounts and
 * the admin's), never to an account typed in that the token cannot see, and never more than `TEST_MAX_CENTS`. Nothing here sends anything: it works out
 * what would be sent, for the admin to confirm.
 */

/** The most a test transfer may be: ten dollars. */
export const TEST_MAX_CENTS = 1000;
/** What a test transfer is when no amount is given: one dollar. */
export const TEST_DEFAULT_CENTS = 100;
/** What a test transfer says it is for. */
export const TEST_DESCRIPTION = 'Flight Panel Bot test transfer';

export class TestTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestTransferError';
  }
}

export interface TestTransfer {
  from: BankAccount;
  to: BankAccount;
  cents: number;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The one account in this list that `input` means: its number (spaces and odd dashes forgiven), or its name (all of it, or the part of it that only one
 * account has). `role` says which end it is, for the message when there is no such account, or more than one.
 */
export function findAccount(accounts: BankAccount[], input: string, role: 'from' | 'to'): BankAccount {
  const text = norm(input);
  if (text === '') throw new TestTransferError(`Say which account the money goes ${role === 'from' ? 'from' : 'to'}.`);
  const byNumber = accounts.filter((a) => a.number.toLowerCase() === norm(cleanAccount(input)));
  if (byNumber.length === 1) return byNumber[0] as BankAccount;
  const exact = accounts.filter((a) => norm(a.name) === text);
  if (exact.length === 1) return exact[0] as BankAccount;
  const partial = accounts.filter((a) => norm(a.name).includes(text));
  if (partial.length === 1) return partial[0] as BankAccount;
  if (partial.length > 1) throw new TestTransferError(`More than one of the accounts I can see matches "${input.trim().slice(0, 40)}": use the account number (\`/payroll accounts\` lists them).`);
  throw new TestTransferError(`I can't see an account matching "${input.trim().slice(0, 40)}" with the FsHub token, and a test only moves money between accounts I can see. \`/payroll accounts\` lists them.`);
}

/** The test transfer an admin asked for, checked: both accounts are ones the token can see, they are different, and the amount is $0.01 to $10. */
export function planTestTransfer(accounts: BankAccount[], fromInput: string, toInput: string, dollars: number | null): TestTransfer {
  const from = findAccount(accounts, fromInput, 'from');
  const to = findAccount(accounts, toInput, 'to');
  if (from.number === to.number) throw new TestTransferError('That is the same account on both sides.');
  const cents = dollars === null ? TEST_DEFAULT_CENTS : Math.round(dollars * 100);
  if (!Number.isFinite(cents) || cents < 1 || cents > TEST_MAX_CENTS) {
    throw new TestTransferError(`A test transfer is between $0.01 and $${(TEST_MAX_CENTS / 100).toFixed(2)}. Use the real payment list for anything else.`);
  }
  return { from, to, cents };
}

/** The payment to send for a test transfer, under this unique ID (which is its idempotency key: sending it twice pays once). */
export const testRequest = (t: TestTransfer, uniqueId: string): PayRequest => ({
  sourceAccount: t.from.number,
  recipientAccount: t.to.number,
  uniqueId,
  cents: t.cents,
  description: TEST_DESCRIPTION,
});
