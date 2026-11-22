import { canon, parseCsv } from '../jobs/import.js';
import { formatMoney, parseMoney, type SheetFlight } from './contributions.js';
import { parsePilotId } from './pilotId.js';
import { PAY_MINIMUM, pilotPay } from './pilotPay.js';

/**
 * Working out who is to be paid what, from the airline's own sheet. No money moves here and nothing is written anywhere: this turns the
 * schedule's completed flights (and the Pilot Pay beside each), and the sheet tab that lists the pilots' bank accounts, into a list of payments
 * for an admin to check. Each payment carries its flags: anything about it that someone should look at before it is paid.
 */

/** The most one payment may be, in cents. A typing slip (an extra zero) is caught by this rather than by the bank. */
export const MAX_PAYMENT_CENTS = 500_000 * 100;
/** An account number as the airline's sheet and Aeroconomy write them: four digits, a dash, the rest (`9954-0000123`). */
export const ACCOUNT_PATTERN = /^\d{4}-\d{3,12}$/;
/** A unique ID: letters, digits, dots, dashes and underscores. */
export const UNIQUE_ID_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;

/** What was typed or written for an account number, with spaces gone and every kind of dash made an ordinary one. */
export const cleanAccount = (text: string): string => text.replace(/[‐-―−]/g, '-').replace(/\s+/g, '');
export const isAccount = (text: string): boolean => ACCOUNT_PATTERN.test(text);

export const centsOf = (dollars: number): number => Math.round(dollars * 100);

/** What is to be paid for a flight, and how it compares with what the sheet's Pilot Pay cell says. */
export interface PayAmount {
  cents: number;
  /** The cell's own amount when the pay is more than it (so the list can say so); null when the cell is paid as it stands. */
  sheetCents: number | null;
  /** The distance, in nautical miles, the pay was worked out from (a flight that lost money, with FsHub's distance known); null otherwise. */
  lossNm: number | null;
  /** The flight lost money and its distance is not known, so the pay by distance could not be worked out and has to be checked. */
  needsDistance: boolean;
}

/**
 * What to pay for a flight whose Pilot Pay cell holds an amount: the cell's amount, but never less than the airline's rule gives.
 * Aeroconomy's own pay for a flight is a share of its profit ($34 on $225), which is not what the airline pays:
 *
 *  - every flight pays at least the $2,000 minimum (a flight that made a profit, or lost money);
 *  - a flight that lost money pays $2,000 for the first 1,000 nm and $1,000 more for every further 500 nm (a started 500 counting as a whole
 *    one), by the distance FsHub recorded (`nm`). Without that distance it can only be raised to the minimum, and says so (`needsDistance`).
 *
 * A cell that already holds more than the rule is paid as it stands. Null when the cell holds no amount (or $0, which is how an unfinished
 * row is kept): no pay is due yet.
 *
 * Where the airline links pay to landing safety (`trustCell`), the cell is the pay as it stands, whatever it holds: a flight that landed hard has
 * had its pay cut when the cell was filled, and raising it to the usual minimum or distance rule would undo the fine.
 */
export function payAmount(f: Pick<SheetFlight, 'payRaw' | 'profit'>, nm: number | null, trustCell = false): PayAmount | null {
  const dollars = parseMoney(f.payRaw);
  if (dollars === null || dollars <= 0) return null;
  const cell = centsOf(dollars);
  if (trustCell) return { cents: cell, sheetCents: null, lossNm: null, needsDistance: false };
  const lost = f.profit !== null && f.profit < 0;
  const byDistance = lost && nm !== null ? pilotPay(f.profit as number, nm) : null;
  const rule = centsOf(byDistance ? byDistance.amount : PAY_MINIMUM);
  const cents = Math.max(cell, rule);
  return { cents, sheetCents: cents > cell ? cell : null, lossNm: byDistance ? nm : null, needsDistance: lost && byDistance === null };
}

/**
 * Whether a flight's row still says what a line on a list was made from: the Pilot Pay cell holds what it held then, and a flight whose pay was
 * worked out by distance is still one that lost money. (A payment an admin amended is the admin's, and is not checked against the cell.)
 */
export function rowStillAgrees(line: Pick<PayLine, 'cents' | 'sheetCents' | 'lossNm'>, f: Pick<SheetFlight, 'payRaw' | 'profit'>): boolean {
  const dollars = parseMoney(f.payRaw);
  if (dollars === null || centsOf(dollars) !== (line.sheetCents ?? line.cents)) return false;
  return line.lossNm === undefined || (f.profit !== null && f.profit < 0);
}

/** `$8,131`, or `$8,131.50` when there are cents. */
export const dollarsText = (cents: number): string => formatMoney(cents / 100);

/** Something about a payment that a person should look at before it is paid. */
export type PayFlag =
  | 'no-info' // the pilot is not on the Pilot Info tab
  | 'ambiguous-info' // they are on it more than once
  | 'no-account' // no bank account written for them
  | 'bad-account' // it is not an account number
  | 'unknown-id' // no FsHub ID, or one the bot has never heard of
  | 'id-mismatch' // the bot ties this name to another FsHub ID
  | 'name-differs' // FsHub knows this ID under a different name
  | 'account-changed' // not the account this pilot was last paid into
  | 'bad-amount' // not a sensible amount
  | 'no-distance'; // lost money, so its pay depends on the distance flown, and FsHub's distance for it is not known

export const FLAG_TEXT: Record<PayFlag, string> = {
  'no-info': 'not on the Pilot Info tab',
  'ambiguous-info': 'on the Pilot Info tab more than once',
  'no-account': 'no bank account on the Pilot Info tab',
  'bad-account': "that isn't an account number (like 9954-0000123)",
  'unknown-id': "no FsHub ID I know for them",
  'id-mismatch': 'I have a different FsHub ID for that name',
  'name-differs': 'FsHub knows that ID by another name',
  'account-changed': 'not the account they were last paid into',
  'bad-amount': 'the amount is not between $0.01 and $500,000',
  'no-distance': "it lost money, so its pay depends on the distance flown, and I couldn't get FsHub's distance for it: check the amount",
};

/** One payment on a list. */
export interface PayLine {
  /** Its reference number on the list (1, 2, 3...). Stays the same when others are amended. */
  n: number;
  /** The flight it is for, by its key in the schedule sheet. */
  sourceKey: string;
  row: number;
  /** The pilot as the schedule names them. */
  pilot: string;
  fshubId: number | null;
  account: string | null;
  cents: number;
  /** When the sheet's Pilot Pay was less than the airline's rule gives and `cents` is the rule's amount instead: what the sheet says. Absent otherwise. */
  sheetCents?: number;
  /** When the pay was worked out from the distance FsHub recorded for a flight that lost money: that distance, in nautical miles. Absent otherwise. */
  lossNm?: number;
  uniqueId: string;
  dep: string;
  arr: string;
  /** Midnight (Zulu) of the flight's day. */
  day: number;
  flags: PayFlag[];
  /** An admin changed (or checked) it on the list. */
  amended: boolean;
  /** Left out of this run: it stays unpaid and comes up on the next list. */
  out: boolean;
}

/** A list of payments, as kept while it waits to be checked. */
export interface PayDraft {
  airline: string;
  made: number;
  sourceAccount: string;
  lines: PayLine[];
  /** Completed flights with nothing to pay yet (no Pilot Pay), so they are not on the list. */
  waiting: number;
  /** Payments begun earlier and never settled: they are not on any list until someone looks at them. */
  unsettled: number;
}

export const isPayable = (l: PayLine): boolean => !l.out && l.flags.length === 0;

export function summarise(lines: PayLine[]): { ready: PayLine[]; totalCents: number; flagged: number; out: number } {
  const ready = lines.filter(isPayable);
  return { ready, totalCents: ready.reduce((sum, l) => sum + l.cents, 0), flagged: lines.filter((l) => !l.out && l.flags.length > 0).length, out: lines.filter((l) => l.out).length };
}

/* ------------------------------------------------------------------ the Pilot Info tab */

export interface PilotInfoRow {
  /** The row in the sheet (1 is the first row). */
  row: number;
  name: string;
  fshubId: number | null;
  account: string;
}

export type PilotInfoRead = { ok: true; rows: PilotInfoRow[] } | { ok: false; reason: string; headers: string[] };

const NAME_COLUMNS = ['pilot', 'pilotname', 'name', 'fullname', 'member'];
const ID_COLUMNS = ['fshubid', 'fshub', 'fshubpilotid', 'fshubuserid', 'fshubnumber', 'pilotid'];
const ACCOUNT_COLUMNS = ['bankacct', 'bankaccount', 'bankaccountnumber', 'bankacctnumber', 'bankacctno', 'bankaccountno', 'account', 'accountnumber', 'acctnumber', 'acct'];

/**
 * Read the tab that lists the pilots: a name, a FsHub ID and a bank account for each. The columns are found by their titles (`Bank Acct`,
 * `FSHUB ID`, and some other ways of writing them); a tab that lacks one is refused, with the titles it does have so the admin can see why.
 */
export function readPilotInfo(csv: string): PilotInfoRead {
  const rows = parseCsv(csv, { keepBlankRows: true });
  let seen: string[] = [];
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const titles = (rows[i] as string[]).map((c) => c.trim());
    const names = titles.map(canon);
    if (titles.every((t) => t === '')) continue;
    if (seen.length === 0) seen = titles.filter(Boolean);
    const find = (exact: string[], loose?: (n: string) => boolean) => {
      const at = names.findIndex((n) => exact.includes(n));
      return at >= 0 ? at : loose ? names.findIndex(loose) : -1;
    };
    const iAccount = find(ACCOUNT_COLUMNS, (n) => n.includes('bank') && (n.includes('acct') || n.includes('account')));
    const iName = find(NAME_COLUMNS);
    const iId = find(ID_COLUMNS, (n) => n.includes('fshub'));
    if (iAccount < 0 || iName < 0 || iId < 0) continue;
    const out: PilotInfoRow[] = [];
    for (let r = i + 1; r < rows.length; r++) {
      const cells = rows[r] as string[];
      const name = (cells[iName] ?? '').trim();
      if (!name) continue;
      out.push({ row: r + 1, name, fshubId: parsePilotId(cells[iId] ?? ''), account: cleanAccount(cells[iAccount] ?? '') });
    }
    return { ok: true, rows: out };
  }
  return {
    ok: false,
    reason: "I couldn't find a name, a FsHub ID and a bank account column (titled something like `Pilot`, `FSHUB ID` and `Bank Acct`) in that tab.",
    headers: seen,
  };
}

/* ------------------------------------------------------------------ names */

const words = (text: string): string[] => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
export const nameKey = (text: string): string => words(text).join(' ');

/** Are these two names plausibly one person? Equal with the spaces gone, or all the words of the shorter one are in the longer. */
export function looselySame(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.length === 0 || y.length === 0) return false;
  if (x.join('') === y.join('')) return true;
  const [small, big] = x.length <= y.length ? [x, y] : [y, x];
  return small.every((w) => big.includes(w));
}

/* ------------------------------------------------------------------ building the list */

/** What the bot already knows about people: how a name, a FsHub ID and a Discord account tie together. */
export interface IdentityBook {
  /** The FsHub IDs the bot ties to a name as written in a sheet. */
  idsForName(name: string): number[];
  /** The names the bot has for a FsHub ID. */
  namesForId(id: number): string[];
  knowsId(id: number): boolean;
}

/** What the ledger of payments already made says. */
export interface LedgerView {
  /** Was this flight already paid for this pilot (or is it being, or was it, with nobody knowing how it ended)? */
  isTaken(sourceKey: string, pilot: string): boolean;
  hasUniqueId(uniqueId: string): boolean;
  /** The unique ID a payment of this flight failed under, so a second try is the same payment. */
  failedIdFor(sourceKey: string, pilot: string): string | null;
  /** The account this FsHub pilot was last paid into. */
  lastAccount(fshubId: number): string | null;
}

export interface BuildInput {
  flights: SheetFlight[];
  info: PilotInfoRow[];
  /** Flights before this day (midnight Zulu) are never paid. Null: no limit. */
  startDay: number | null;
  ledger: LedgerView;
  identities: IdentityBook;
  /** The airline's own number for a flight (`SKY516`), if the bot has one for the sheet row. */
  flightRef(row: SheetFlight): string | null;
  /** The distance FsHub recorded for flights, in nautical miles, by the flight's key in the sheet: what a flight that lost money is paid by. */
  distances?: ReadonlyMap<string, number>;
  /** The airline links pay to landing safety, so the Pilot Pay cell is paid as it stands (see `payAmount`). */
  trustCell?: boolean;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** `111926`: month, day and two-digit year of a Zulu day. */
export const dateStamp = (day: number): string => {
  const d = new Date(day);
  return `${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCFullYear() % 100)}`;
};

/** The flags that follow from the account and the amount alone (they are worked out again for whatever an admin types). */
export function structuralFlags(account: string | null, cents: number): PayFlag[] {
  const flags: PayFlag[] = [];
  if (account === null || account === '') flags.push('no-account');
  else if (!isAccount(account)) flags.push('bad-account');
  if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_PAYMENT_CENTS) flags.push('bad-amount');
  return flags;
}

const endpoints = (route: string): { dep: string; arr: string } => {
  const codes = route.match(/[A-Z0-9]{3,4}/g) ?? [];
  return { dep: codes[0] ?? '????', arr: codes[codes.length - 1] ?? '????' };
};

/**
 * The payments due: every completed flight whose Pilot Pay is filled in with an amount, whose Pilot Paid box is not ticked, that is on or after
 * the first day to be paid, and that the ledger does not already have. Each gets the pilot's account from the Pilot Info tab, a unique ID, and
 * its flags. Oldest first.
 *
 * The unique ID is the pilot's FsHub ID, the two airports and the date (`32411-KORD-EGLL-111926`). When that would be the same for two flights
 * (the same pilot flying the same route twice in a day, here or already paid earlier), the flight's number is added to each.
 */
export function buildPayLines(input: BuildInput): { lines: PayLine[]; waiting: number } {
  const { ledger, identities } = input;
  let waiting = 0;
  const due: Array<{ flight: SheetFlight; pay: PayAmount }> = [];
  for (const f of input.flights) {
    if (!f.completed || f.pilot.trim() === '' || (input.startDay !== null && f.day < input.startDay)) continue;
    if (f.pilotPaid === true || ledger.isTaken(f.sourceKey, f.pilot)) continue;
    const pay = payAmount(f, input.distances?.get(f.sourceKey) ?? null, input.trustCell === true);
    if (pay === null) {
      waiting++;
      continue;
    }
    due.push({ flight: f, pay });
  }
  due.sort((a, b) => a.flight.day - b.flight.day || a.flight.row - b.flight.row);

  const infoByName = new Map<string, PilotInfoRow[]>();
  for (const r of input.info) infoByName.set(nameKey(r.name), [...(infoByName.get(nameKey(r.name)) ?? []), r]);

  const drafts = due.map(({ flight: f, pay }) => {
    const { cents, sheetCents, lossNm } = pay;
    const matches = infoByName.get(nameKey(f.pilot)) ?? [];
    const info = matches.length === 1 ? (matches[0] as PilotInfoRow) : null;
    const flags: PayFlag[] = [];
    if (matches.length === 0) flags.push('no-info');
    else if (matches.length > 1) flags.push('ambiguous-info');
    const account = info ? (info.account === '' ? null : info.account) : null;
    const fshubId = info?.fshubId ?? null;
    // With no row on the Pilot Info tab there is no account to judge, only the amount.
    for (const flag of structuralFlags(account, cents)) if (info || flag === 'bad-amount') flags.push(flag);
    if (info) flags.push(...identityFlags(f.pilot, info, identities, ledger, account));
    if (pay.needsDistance) flags.push('no-distance');
    return { f, cents, sheetCents, lossNm, account, fshubId, flags: [...new Set(flags)], ...endpoints(f.route) };
  });

  const base = (d: (typeof drafts)[number]) => `${d.fshubId ?? 'NOID'}-${d.dep}-${d.arr}-${dateStamp(d.f.day)}`;
  const shared = new Map<string, number>();
  for (const d of drafts) shared.set(base(d), (shared.get(base(d)) ?? 0) + 1);
  const used = new Set<string>();
  const lines: PayLine[] = drafts.map((d, i) => {
    const retry = ledger.failedIdFor(d.f.sourceKey, d.f.pilot);
    let id: string;
    if (retry) id = retry;
    else {
      const ref = (input.flightRef(d.f) ?? '').replace(/\D/g, '');
      id = (shared.get(base(d)) ?? 0) > 1 || ledger.hasUniqueId(base(d)) ? `${base(d)}-${ref || `r${d.f.row}`}` : base(d);
    }
    let unique = id;
    for (let k = 2; used.has(unique) || (!retry && ledger.hasUniqueId(unique)); k++) unique = `${id}-${k}`;
    used.add(unique);
    return {
      n: i + 1,
      sourceKey: d.f.sourceKey,
      row: d.f.row,
      pilot: d.f.pilot,
      fshubId: d.fshubId,
      account: d.account,
      cents: d.cents,
      ...(d.sheetCents !== null ? { sheetCents: d.sheetCents } : {}),
      ...(d.lossNm !== null ? { lossNm: d.lossNm } : {}),
      uniqueId: unique,
      dep: d.dep,
      arr: d.arr,
      day: d.f.day,
      flags: d.flags,
      amended: false,
      out: false,
    };
  });
  return { lines, waiting };
}

/** What cross-checking the Pilot Info row against everything the bot knows about the person turns up. */
function identityFlags(sheetName: string, info: PilotInfoRow, who: IdentityBook, ledger: LedgerView, account: string | null): PayFlag[] {
  if (info.fshubId === null) return ['unknown-id'];
  const flags: PayFlag[] = [];
  const tied = who.idsForName(sheetName);
  if (tied.length > 0 && !tied.includes(info.fshubId)) flags.push('id-mismatch');
  else if (!who.knowsId(info.fshubId)) flags.push('unknown-id');
  else if (!tied.includes(info.fshubId)) {
    // The bot knows this ID but nothing ties the sheet's name to it, so the name FsHub has for it has to be the one in the sheet.
    const names = who.namesForId(info.fshubId);
    if (names.length > 0 && !names.some((n) => looselySame(n, info.name) || looselySame(n, sheetName))) flags.push('name-differs');
  }
  const last = ledger.lastAccount(info.fshubId);
  if (last !== null && account !== null && last !== account) flags.push('account-changed');
  return flags;
}

/* ------------------------------------------------------------------ amending */

export interface AmendFields {
  account: string;
  amount: string;
  uniqueId: string;
}

/** An amount as an admin types it: `8131`, `$8,131.50`, or `0` (also `skip`) to leave the payment out of this run. */
export function parseAmount(text: string): { cents: number } | { out: true } | { error: string } {
  const t = text.trim().replace(/[$,\s]/g, '');
  if (/^(?:0+(?:\.0+)?|skip|remove|out|-)$/i.test(t)) return { out: true };
  if (!/^\d+(?:\.\d{1,2})?$/.test(t)) return { error: 'The amount has to be a number of dollars, like 8131 or 8131.50 (0 leaves the payment out of this run).' };
  const cents = centsOf(Number(t));
  if (cents <= 0 || cents > MAX_PAYMENT_CENTS) return { error: `The amount has to be between $0.01 and ${dollarsText(MAX_PAYMENT_CENTS)}.` };
  return { cents };
}

/**
 * Change one payment on a list. Whatever the admin leaves as it was is kept; pressing submit on a payment that was flagged without changing
 * anything is how they say they have checked it (the account and the amount still have to be good ones, and the unique ID unused). Returns the
 * new list, or why it was refused, with nothing changed.
 */
export function amendLine(lines: PayLine[], n: number, fields: AmendFields, taken: (uniqueId: string) => boolean): { ok: true; lines: PayLine[] } | { ok: false; error: string } {
  const line = lines.find((l) => l.n === n);
  if (!line) return { ok: false, error: `There is no payment number ${n} on this list.` };
  const account = cleanAccount(fields.account);
  if (!isAccount(account)) return { ok: false, error: "That isn't an account number. It looks like 9954-0000123." };
  const amount = parseAmount(fields.amount);
  if ('error' in amount) return { ok: false, error: amount.error };
  const uniqueId = fields.uniqueId.trim();
  if (!UNIQUE_ID_PATTERN.test(uniqueId)) return { ok: false, error: 'A unique ID is 3 to 64 letters, digits, dots, dashes or underscores.' };
  if (lines.some((l) => l.n !== n && l.uniqueId === uniqueId)) return { ok: false, error: `Another payment on this list already has the unique ID ${uniqueId}.` };
  if (uniqueId !== line.uniqueId && taken(uniqueId)) return { ok: false, error: `The unique ID ${uniqueId} has been used for a payment before, so it can't be used again.` };
  const next: PayLine = { ...line, account, uniqueId, amended: true, flags: [], out: 'out' in amount, cents: 'cents' in amount ? amount.cents : line.cents };
  return { ok: true, lines: lines.map((l) => (l.n === n ? next : l)) };
}
