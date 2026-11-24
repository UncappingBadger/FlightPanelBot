import { parseCsv, parseLegChain } from '../jobs/import.js';
import { DEDUCTION_COLUMNS, findHeader, isCancelled, isTicked, PAID_COLUMNS, parseSheetDate, PAY_COLUMNS, PROFIT_COLUMNS } from '../jobs/sheet.js';
import { normalizeFlightNumber } from '../jobs/types.js';

/**
 * What a pilot's completed flights made for the airline, worked out from the airline's own Google Sheet: the flights a
 * pilot completed in the last few days, and the *Profit Made* a manager entered against each. The sheet is the record, so
 * this reads the sheet itself rather than anything the bot keeps.
 */

const DAY = 86_400_000;

/** The period a pilot's contributions are added up over: today and the days before it, this many in all. */
export const CONTRIBUTION_DAYS = 7;

/** One row of the schedule, as far as contributions are concerned. */
export interface SheetFlight {
  /** The row in the sheet (1 is the first row). */
  row: number;
  /** The route as the sheet writes it, like `EGLL → EGKK`. */
  route: string;
  /** The flight's own key: the same one the panel's flights have, so the flight can be found there. */
  sourceKey: string;
  /** The airline's flight number, if the sheet has such a column and this row has one. */
  flightNumber: string | null;
  /** Midnight (Zulu) at the start of the flight's day. */
  day: number;
  pilot: string;
  completed: boolean;
  /** The profit a manager entered, which may be negative; null while the cell is empty or isn't a number. */
  profit: number | null;
  /** What is in the Profit Made cell, exactly as it is (not trimmed): empty only if the cell is. Null when the sheet has no such column. */
  profitRaw: string | null;
  /** What is in the Pilot Pay cell, exactly as it is (not trimmed): empty only if the cell is. Null when the sheet has no such column. */
  payRaw: string | null;
  /** What is in the Safety Deductions cell, exactly as it is. Null when the sheet has no such column; absent where it was not read. */
  deductionRaw?: string | null;
  /** Is the Pilot Paid box ticked (the pilot has been paid for this flight)? Null when the sheet has no such column; absent where it was not read. */
  pilotPaid?: boolean | null;
}

export interface SheetFlights {
  flights: SheetFlight[];
  /** Does the sheet have a profit column at all? */
  hasProfit: boolean;
  /** Does it have a Pilot Pay column? */
  hasPay: boolean;
  /** Does it have a Safety Deductions column? */
  hasDeduction?: boolean;
}

/**
 * A money cell as a spreadsheet shows it: `$54,489.00`, `-$114,799.00`, `($1,200)`, `1200`, `£3.50`. Null when it is empty or
 * isn't an amount (`TBD`, `#N/A`, a dash).
 */
export function parseMoney(text: string | null | undefined): number | null {
  let t = (text ?? '').trim();
  if (!t) return null;
  const bracketed = /^\(.*\)$/.test(t);
  if (bracketed) t = t.slice(1, -1).trim();
  // A sign belongs at the front, before or after the currency sign (`-$5`, `$-5`); a dash anywhere else is not a sign (`2026-11-20` is a date, `0-0`
  // a note, `8,131-` and `1.234,50` are not written the way this reads amounts), so those are not amounts rather than the wrong amount.
  const m = MONEY.exec(t);
  if (!m) return null;
  const [, lead, afterCurrency, digits] = m as unknown as [string, string | undefined, string | undefined, string];
  if (lead && afterCurrency) return null;
  // Thousands separators and the spaces between digit groups go; what is left has to be a plain number.
  const core = digits.replace(/[,'\s]/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(core)) return null;
  const n = Number(core);
  if (!Number.isFinite(n)) return null;
  return bracketed || /[-−–]/.test(lead ?? afterCurrency ?? '') ? -n : n;
}

/** A money cell: an optional sign, an optional currency sign, an optional sign, the digits (thousands separators and spaces allowed), an optional currency sign. */
const MONEY = /^([+\-−–])?\s*[$£€¥]?\s*([+\-−–])?\s*(\d[\d,'\s]*(?:\.\d*)?|\.\d+)\s*[$£€¥]?$/;

/**
 * Whether a Pilot Pay cell, as it shows or is stored, has no pay in it: nothing at all, or a plain zero (`$0`, `0`, `$0.00`). A column
 * formatted as money fills its empty cells with $0, so a zero is not somebody's decision to pay nothing, and may be written over. Anything
 * else, a note (`TBD`), a stray space or a formula, even one that works out to zero, is somebody's, and is not.
 */
export const isUnsetPay = (text: string | null | undefined): boolean => (text ?? '') === '' || parseMoney(text) === 0;

/** `$1,234`, `-$114,799`, `$1,234.50`: whole amounts without cents, as the sheet is usually kept. */
export function formatMoney(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const text = Math.abs(rounded).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(rounded) ? 0 : 2, maximumFractionDigits: 2 });
  return `${rounded < 0 ? '-' : ''}$${text}`;
}

/** `Mon 9 Nov`, for a Zulu day. */
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayName = (day: number): string => {
  const d = new Date(day);
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]}`;
};

/**
 * Read every flight row of an airline's schedule tab, old ones included, with the pilot, whether it was completed, and the
 * profit entered against it. Null if the sheet is not a schedule (no Route, Date, Pilot and Flight Completed columns).
 */
export function readSheetFlights(csv: string): SheetFlights | null {
  const rows = parseCsv(csv, { keepBlankRows: true });
  const header = findHeader(rows);
  if (!header) return null;
  const { names } = header;
  const at = (pred: (n: string) => boolean) => names.findIndex(pred);
  const iRoute = at((n) => n === 'route');
  const iDate = at((n) => n === 'date');
  const iPilot = at((n) => n === 'pilot');
  const iDone = at((n) => n.startsWith('flightcompleted') || n === 'completed');
  const iProfit = at((n) => PROFIT_COLUMNS.includes(n));
  const iPay = at((n) => PAY_COLUMNS.includes(n));
  const iDeduction = at((n) => DEDUCTION_COLUMNS.includes(n));
  const iPaid = at((n) => PAID_COLUMNS.includes(n));
  const iFlightNo = at((n) => ['flightnumber', 'flightno', 'flightnum', 'flightid', 'fltno', 'fltnumber', 'flt', 'flight'].includes(n));
  if (iRoute < 0 || iDate < 0 || iPilot < 0 || iDone < 0) return null;

  const flights: SheetFlight[] = [];
  const seen = new Map<string, number>();
  for (let i = header.index + 1; i < rows.length; i++) {
    const r = rows[i] as string[];
    const cell = (c: number) => (c >= 0 ? (r[c] ?? '').trim() : '');
    const route = cell(iRoute);
    if (!route || /^week\b/i.test(route)) continue;
    const legs = parseLegChain(route);
    if (typeof legs === 'string') continue;
    const date = parseSheetDate(cell(iDate));
    if (!date) continue;

    const day = Date.UTC(date.y, date.m - 1, date.d);
    const dayKey = `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
    const base = `${legs.map((l) => `${l.dep}-${l.arr}`).join('+')}@${dayKey}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);

    const pilot = cell(iPilot);
    flights.push({
      row: i + 1,
      route: legs.map((l) => `${l.dep} → ${l.arr}`).join(', '),
      sourceKey: nth === 1 ? base : `${base}#${nth}`,
      flightNumber: iFlightNo >= 0 ? normalizeFlightNumber(cell(iFlightNo)) : null,
      day,
      pilot,
      // A cancelled flight often has the box ticked to settle the books, but nobody flew it.
      completed: !isCancelled(pilot) && isTicked(cell(iDone)),
      profit: iProfit >= 0 ? parseMoney(cell(iProfit)) : null,
      profitRaw: iProfit >= 0 ? (r[iProfit] ?? '') : null,
      payRaw: iPay >= 0 ? (r[iPay] ?? '') : null,
      deductionRaw: iDeduction >= 0 ? (r[iDeduction] ?? '') : null,
      pilotPaid: iPaid >= 0 ? isTicked(cell(iPaid)) : null,
    });
  }
  return { flights, hasProfit: iProfit >= 0, hasPay: iPay >= 0, hasDeduction: iDeduction >= 0 };
}

/** The days a pilot's contributions cover as of `now`: from the first midnight (Zulu) up to the end of today. */
export function contributionPeriod(now: number, days: number = CONTRIBUTION_DAYS): { start: number; end: number; lastDay: number } {
  const today = Math.floor(now / DAY) * DAY;
  return { start: today - (days - 1) * DAY, end: today + DAY, lastDay: today };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface Contributions {
  /** Completed flights in the period that carry the pilot's name, oldest first. */
  completed: SheetFlight[];
  /** Those with a profit entered. */
  calculated: SheetFlight[];
  /** Those a manager has not entered a profit for yet. */
  waiting: SheetFlight[];
  /** The profit of the calculated flights added up (it is only what can be seen: the waiting ones are not in it). */
  total: number;
}

/** What the flights the pilot completed in the period made, and which have no profit entered yet. */
export function contributionsOf(sheet: SheetFlights, names: string[], now: number, days: number = CONTRIBUTION_DAYS): Contributions {
  const { start, end } = contributionPeriod(now, days);
  const completed = sheet.flights
    .filter((f) => f.completed && f.day >= start && f.day < end && names.some((n) => sameName(n, f.pilot)))
    .sort((a, b) => a.day - b.day || a.row - b.row);
  const calculated = completed.filter((f) => f.profit !== null);
  const waiting = completed.filter((f) => f.profit === null);
  return { completed, calculated, waiting, total: calculated.reduce((sum, f) => sum + (f.profit as number), 0) };
}
