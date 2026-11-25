import { AeroconomyError } from '../aeroconomy/http.js';
import type { AeroconomyBankingClient, BankAccount, BankTransaction } from '../aeroconomy/banking.js';
import type { BankingAccount, BankingLink, Store } from '../db/store.js';
import { fshubTokenProblem, normalizeFsHubToken } from '../fshub/client.js';
import { silentLogger, type Logger } from '../util/log.js';
import { accountLostText, manyPaymentsText, NO_ACCOUNTS_LEFT_TEXT, paymentMessage, TOKEN_LOST_TEXT, TOKEN_REJECTED_TEXT } from './bankingText.js';
import type { SecretBox } from './secretBox.js';
import { appNow } from '../util/clock.js';

/**
 * Tells a pilot, in a private message, when money goes into or out of the Aeroconomy bank accounts they chose (`/banking`).
 *
 * It needs the pilot's own API token to read their accounts, which they send in a DM. The token is kept sealed (see `SecretBox`), used only to read
 * (accounts and payments: nothing is ever paid or moved), and deleted the moment the pilot turns the messages off, or Aeroconomy stops accepting it. Nothing
 * about a pilot's accounts is kept except which ones they chose and the number of the newest payment already told, so a payment is told once.
 */

/** How often a pilot's accounts are looked at. */
export const BANKING_POLL_MS = 5 * 60_000;
/** After a message could not be delivered (their DMs are closed), the next look is this far off. */
export const BANKING_RETRY_MS = 60 * 60_000;
/** A conversation waiting for a token, or for the accounts to be chosen once it was sent, is dropped (and the token deleted) after this long. */
export const TOKEN_WAIT_MS = 30 * 60_000;
/** A pilot gets this many tries at sending a token that works. */
export const MAX_TOKEN_TRIES = 3;
/** The most payments sent one by one after a single look; more than this are summed up in one line. */
export const MAX_PAYMENT_MESSAGES = 10;
/** Payments are asked for this many at a time, for at most this many pages, in one look at one account. */
const PAGE = 50;
const MAX_PAGES = 4;

export type TokenResult =
  | { kind: 'not-waiting' }
  /** The text is not a token at all (`message` says what one looks like), or Aeroconomy did not accept it. `gaveUp` is set when that was the last try. */
  | { kind: 'bad-shape'; message: string; gaveUp: boolean }
  | { kind: 'rejected'; gaveUp: boolean }
  /** The token works but Aeroconomy will not show it any bank accounts. */
  | { kind: 'forbidden' }
  /** Aeroconomy could not be asked just now. */
  | { kind: 'unavailable'; message: string }
  | { kind: 'no-accounts' }
  | { kind: 'accounts'; accounts: BankAccount[] };

export type OfferResult =
  | { kind: 'none' }
  | { kind: 'waiting' }
  | { kind: 'accounts'; accounts: BankAccount[]; watched: ReadonlySet<string> }
  /** The link is gone: Aeroconomy no longer accepts the token, or it can no longer be read, or the accounts are all gone. The token has been deleted. */
  | { kind: 'ended'; why: 'rejected' | 'lost' | 'no-accounts' }
  | { kind: 'unavailable'; message: string };

export type ChooseResult =
  | { kind: 'none' }
  | { kind: 'nothing-chosen' }
  | { kind: 'ended'; why: 'rejected' | 'lost' }
  /** Every account chosen is one Aeroconomy will not show this token; nothing was changed. */
  | { kind: 'unreadable'; names: string[] }
  | { kind: 'ok'; accounts: BankingAccount[]; unreadable: string[] };

export interface BankingDeps {
  store: Store;
  client: Pick<AeroconomyBankingClient, 'accounts' | 'transactions'>;
  box: SecretBox;
  /** Sends a private message; false if it could not be delivered. */
  send: (discordId: string, content: string) => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
}

interface Collected {
  account: BankingAccount;
  /** The newest payment number seen (or where an account that was not looked at before stands now). */
  top: number;
  news: BankTransaction[];
}

export class BankingService {
  private readonly now: () => number;
  private readonly log: Logger;
  private running = false;
  private current: Promise<void> = Promise.resolve();

  constructor(private readonly d: BankingDeps) {
    this.now = d.now ?? appNow;
    this.log = d.logger ?? silentLogger;
  }

  /* ------------------------------------------------------------------ the conversation */

  /** Where a pilot stands. A conversation that has waited too long for its token is forgotten first. */
  link(discordId: string): BankingLink | null {
    const link = this.d.store.getBankingLink(discordId);
    // A conversation left half done (waiting for the token, or a token sent and no accounts chosen) is dropped, and a token it held with it.
    if (link && link.step !== 'active' && link.expiresAt !== null && link.expiresAt <= this.now()) {
      this.d.store.deleteBankingLink(discordId);
      return null;
    }
    return link;
  }

  accountsOf(discordId: string): BankingAccount[] {
    return this.d.store.listBankingAccounts(discordId);
  }

  /** Is this pilot being waited on for a token? */
  isWaitingForToken(discordId: string): boolean {
    return this.link(discordId)?.step === 'await_token';
  }

  /** Start (or start again) waiting for a pilot's token. Only for someone who has no link yet, or is already waiting. */
  beginSetup(discordId: string): void {
    const now = this.now();
    const have = this.link(discordId);
    if (have && have.step !== 'await_token') return;
    this.d.store.saveBankingLink({ discordId, step: 'await_token', tokenSealed: null, offered: [], attempts: have?.attempts ?? 0, expiresAt: now + TOKEN_WAIT_MS, createdAt: have?.createdAt ?? now, nextPollAt: null, lastOkAt: null });
  }

  /** Stop waiting for a token (they said cancel). True if they were waited on. */
  cancelSetup(discordId: string): boolean {
    if (this.link(discordId)?.step !== 'await_token') return false;
    return this.d.store.deleteBankingLink(discordId);
  }

  /** Turn payment messages off: the token and the chosen accounts are deleted. True if there was anything to delete. */
  turnOff(discordId: string): boolean {
    return this.d.store.deleteBankingLink(discordId);
  }

  /**
   * What a pilot sent while being waited on: try it as their token. A token that works is saved sealed, and the accounts it shows are returned for them to
   * choose from. A text that is not a token at all costs a try, as does one Aeroconomy does not accept; three tries and the conversation ends.
   */
  async submitToken(discordId: string, raw: string): Promise<TokenResult> {
    const link = this.link(discordId);
    if (!link || link.step !== 'await_token') return { kind: 'not-waiting' };
    const problem = fshubTokenProblem(raw);
    if (problem) return this.failedTry(link, { kind: 'bad-shape', message: problem, gaveUp: false });
    const token = normalizeFsHubToken(raw);
    let accounts: BankAccount[];
    try {
      accounts = await this.d.client.accounts(token);
    } catch (e) {
      if (!(e instanceof AeroconomyError)) throw e;
      if (e.status === 401) return this.failedTry(link, { kind: 'rejected', gaveUp: false });
      if (e.status === 403) return { kind: 'forbidden' };
      return { kind: 'unavailable', message: e.message };
    }
    if (accounts.length === 0) {
      this.d.store.deleteBankingLink(discordId);
      return { kind: 'no-accounts' };
    }
    this.d.store.saveBankingLink({ ...link, step: 'choose', tokenSealed: this.d.box.seal(token), offered: accounts.map((a) => ({ number: a.number, name: a.name, type: a.type })), attempts: 0, expiresAt: this.now() + TOKEN_WAIT_MS, nextPollAt: null });
    return { kind: 'accounts', accounts };
  }

  private failedTry(link: BankingLink, result: { kind: 'bad-shape'; message: string; gaveUp: boolean } | { kind: 'rejected'; gaveUp: boolean }): TokenResult {
    const attempts = link.attempts + 1;
    if (attempts >= MAX_TOKEN_TRIES) {
      this.d.store.deleteBankingLink(link.discordId);
      return { ...result, gaveUp: true };
    }
    this.d.store.saveBankingLink({ ...link, attempts, expiresAt: this.now() + TOKEN_WAIT_MS });
    return result;
  }

  /** The accounts a pilot can choose from now (asked of Aeroconomy again with the token they gave), and which of them are watched. */
  async offer(discordId: string): Promise<OfferResult> {
    const link = this.link(discordId);
    if (!link) return { kind: 'none' };
    if (link.step === 'await_token') return { kind: 'waiting' };
    const token = this.d.box.open(link.tokenSealed);
    if (token === null) {
      this.d.store.deleteBankingLink(discordId);
      return { kind: 'ended', why: 'lost' };
    }
    let accounts: BankAccount[];
    try {
      accounts = await this.d.client.accounts(token);
    } catch (e) {
      if (!(e instanceof AeroconomyError)) throw e;
      if (e.status === 401) {
        this.d.store.deleteBankingLink(discordId);
        return { kind: 'ended', why: 'rejected' };
      }
      return { kind: 'unavailable', message: e.message };
    }
    if (accounts.length === 0) {
      this.d.store.deleteBankingLink(discordId);
      return { kind: 'ended', why: 'no-accounts' };
    }
    this.d.store.saveBankingLink({ ...link, offered: accounts.map((a) => ({ number: a.number, name: a.name, type: a.type })), ...(link.step === 'choose' ? { expiresAt: this.now() + TOKEN_WAIT_MS } : {}) });
    return { kind: 'accounts', accounts, watched: new Set(this.d.store.listBankingAccounts(discordId).map((a) => a.number)) };
  }

  /**
   * The pilot picked the accounts to watch (from the ones last offered to them). An account already watched keeps its place; a new one starts from the
   * payment that is newest now, so only payments after this are told. An account Aeroconomy will not show the token is left out and reported.
   */
  async choose(discordId: string, numbers: string[]): Promise<ChooseResult> {
    const link = this.link(discordId);
    if (!link || link.step === 'await_token') return { kind: 'none' };
    const picked = link.offered.filter((o) => numbers.includes(o.number));
    if (picked.length === 0) return { kind: 'nothing-chosen' };
    const token = this.d.box.open(link.tokenSealed);
    if (token === null) {
      this.d.store.deleteBankingLink(discordId);
      return { kind: 'ended', why: 'lost' };
    }
    const have = new Map(this.d.store.listBankingAccounts(discordId).map((a) => [a.number, a]));
    const kept: Array<{ number: string; name: string; kind: string | null; lastTxId: number | null }> = [];
    const unreadable: string[] = [];
    for (const o of picked) {
      const existing = have.get(o.number);
      if (existing) {
        kept.push({ number: o.number, name: o.name, kind: o.type, lastTxId: existing.lastTxId });
        continue;
      }
      try {
        const page = await this.d.client.transactions(token, o.number, { limit: 1 });
        kept.push({ number: o.number, name: o.name, kind: o.type, lastTxId: page.transactions[0]?.id ?? 0 });
      } catch (e) {
        if (!(e instanceof AeroconomyError)) throw e;
        if (e.status === 401) {
          this.d.store.deleteBankingLink(discordId);
          return { kind: 'ended', why: 'rejected' };
        }
        if (e.status === 403 || e.status === 404) unreadable.push(o.name);
        // Anything else (Aeroconomy busy): the account is watched, and where it stands is noted at the first look.
        else kept.push({ number: o.number, name: o.name, kind: o.type, lastTxId: null });
      }
    }
    if (kept.length === 0) return { kind: 'unreadable', names: unreadable };
    const now = this.now();
    this.d.store.replaceBankingAccounts(discordId, kept);
    this.d.store.saveBankingLink({ ...link, step: 'active', attempts: 0, expiresAt: null, nextPollAt: now + BANKING_POLL_MS });
    return { kind: 'ok', accounts: this.d.store.listBankingAccounts(discordId), unreadable };
  }

  /* ------------------------------------------------------------------ the watching */

  /** Look at every pilot whose accounts are due. Overlapping runs are skipped. */
  run(): Promise<void> {
    if (this.running) return this.current;
    this.running = true;
    this.current = (async () => {
      try {
        this.d.store.purgeBankingSetups(this.now());
        for (const link of this.d.store.listDueBankingLinks(this.now())) {
          await this.poll(link).catch((e) => this.log.warn('Looking at a pilot\'s bank accounts failed', e));
        }
      } finally {
        this.running = false;
      }
    })();
    return this.current;
  }

  idle(): Promise<void> {
    return this.current;
  }

  /** End a pilot's link because something outside their control ended it, and say so (the token is gone either way). */
  private async end(discordId: string, text: string): Promise<void> {
    this.d.store.deleteBankingLink(discordId);
    await this.d.send(discordId, text).catch(() => false);
  }

  /** The new payments of one account since the one last told. An account not looked at before only notes where it stands. */
  private async collect(token: string, account: BankingAccount): Promise<Collected> {
    if (account.lastTxId === null) {
      const page = await this.d.client.transactions(token, account.number, { limit: 1 });
      return { account, top: page.transactions[0]?.id ?? 0, news: [] };
    }
    const last = account.lastTxId;
    const news: BankTransaction[] = [];
    let top = last;
    let before: number | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await this.d.client.transactions(token, account.number, { limit: PAGE, beforeId: before });
      let reachedOld = false;
      for (const t of got.transactions) {
        if (t.id > last) {
          if (!news.some((n) => n.id === t.id)) news.push(t);
          top = Math.max(top, t.id);
        } else reachedOld = true;
      }
      if (reachedOld || !got.hasMore || got.nextCursor === null || got.transactions.length === 0) break;
      before = got.nextCursor;
    }
    return { account, top, news: news.sort((a, b) => a.id - b.id) };
  }

  private async poll(link: BankingLink): Promise<void> {
    const userId = link.discordId;
    const now = this.now();
    const token = this.d.box.open(link.tokenSealed);
    if (token === null) return this.end(userId, TOKEN_LOST_TEXT);
    const accounts = this.d.store.listBankingAccounts(userId);
    if (accounts.length === 0) {
      this.d.store.deleteBankingLink(userId);
      return;
    }

    const collected: Collected[] = [];
    const lost: BankingAccount[] = [];
    let trouble = false;
    for (const account of accounts) {
      try {
        collected.push(await this.collect(token, account));
      } catch (e) {
        if (!(e instanceof AeroconomyError)) throw e;
        if (e.status === 401) return this.end(userId, TOKEN_REJECTED_TEXT);
        if (e.status === 403 || e.status === 404) lost.push(account);
        else {
          trouble = true;
          this.log.debug(`Bank account of ${userId} could not be read this time: ${e.message}`);
        }
      }
    }

    // One message for each payment, oldest first; a payment between two of their own accounts is one message, not two.
    const byId = new Map<number, { tx: BankTransaction; accounts: BankingAccount[] }>();
    for (const c of collected) {
      for (const tx of c.news) {
        const entry = byId.get(tx.id) ?? { tx, accounts: [] };
        entry.accounts.push(c.account);
        byId.set(tx.id, entry);
      }
    }
    const all = [...byId.values()].sort((a, b) => a.tx.id - b.tx.id);
    const shown = all.slice(-MAX_PAYMENT_MESSAGES);
    let failed = false;
    if (all.length > shown.length && !(await this.d.send(userId, manyPaymentsText(all.length, shown.length)))) failed = true;
    const told = new Map<string, number>();
    for (const item of shown) {
      if (failed) break;
      if (!(await this.d.send(userId, paymentMessage(item.tx, item.accounts)))) {
        failed = true;
        break;
      }
      for (const a of item.accounts) told.set(a.number, Math.max(told.get(a.number) ?? 0, item.tx.id));
    }

    // Where each account now stands: everything it showed, if all was told; otherwise only what reached them (so the rest is tried again).
    for (const c of collected) {
      const stands = failed ? (told.get(c.account.number) ?? null) : c.top;
      if (stands !== null && stands !== c.account.lastTxId) this.d.store.setBankingCursor(userId, c.account.number, stands);
    }

    for (const a of lost) {
      this.d.store.removeBankingAccount(userId, a.number);
      await this.d.send(userId, accountLostText(a)).catch(() => false);
    }
    if (lost.length > 0 && this.d.store.listBankingAccounts(userId).length === 0) return this.end(userId, NO_ACCOUNTS_LEFT_TEXT);

    this.d.store.saveBankingLink({ ...link, nextPollAt: now + (failed ? BANKING_RETRY_MS : BANKING_POLL_MS), lastOkAt: trouble || failed ? link.lastOkAt : now });
  }
}
