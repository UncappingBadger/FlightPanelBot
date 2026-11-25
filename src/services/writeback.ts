import type { Panel } from '../db/store.js';
import { SheetsError, type Cell, type SheetsPort } from '../google/sheetsApi.js';
import { parseLegChain } from '../jobs/import.js';
import { normalizeFlightNumber, type NumberlessRow } from '../jobs/types.js';
import { isUnsetPay, parseMoney } from './contributions.js';
import { colLetter, findHeader, isCancelled, isTicked, PAID_COLUMNS, parseScheduleValues, parseSheetDate, sheetRefOf, type SheetRef } from '../jobs/sheet.js';
import { DEBUG_BUILD, callerPath, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';
import { appNow, realMs } from '../util/clock.js';

export type WriteBackErrorCode =
  /** The panel has no Google Sheet linked. */
  | 'NO_SHEET'
  /** The tab has no Pilot or Flight Completed column. */
  | 'NO_COLUMNS'
  /** The flight's row can't be found any more. */
  | 'FLIGHT_NOT_FOUND'
  /** Someone else is already named against the flight in the sheet. */
  | 'CONFLICT'
  /** The sheet already shows the flight as completed or cancelled. */
  | 'CLOSED'
  /** Google refused or couldn't be reached. */
  | 'GOOGLE';

/** A write to the sheet that could not be done. `message` is safe to show to a pilot. */
export class WriteBackError extends Error {
  constructor(
    readonly code: WriteBackErrorCode,
    message: string,
    /** For CONFLICT: the name the sheet already has. */
    readonly existing: string | null = null,
  ) {
    super(message);
    this.name = 'WriteBackError';
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Formats that would show a distance as something else: a column copied from the Date column shows 392 as 1/26/1901, one copied from a money
 * column as $392.00. A cell with one of these is given a plain number format before a distance is written into it. A cell with no format, a
 * number format (plain, or one like `0 "NM"`) or a text format is left exactly as it is.
 */
const MISLEADING_FORMATS = new Set(['DATE', 'TIME', 'DATE_TIME', 'CURRENCY', 'PERCENT', 'SCIENTIFIC']);
const DISTANCE_FORMAT = { type: 'NUMBER', pattern: '#,##0' };

/** A profit to write into a blank Profit Made cell, and what the row looked like when the profit was worked out. */
export interface ProfitFill {
  sourceKey: string;
  /** Whole dollars, as the sheet is kept. */
  value: number;
  /** The row and the pilot's name it had a moment ago: if either has changed since, nothing is written to it. */
  row: number;
  pilot: string;
  /** What the pilot is paid for the flight, in whole dollars, for the row's Pilot Pay cell; written only if that cell has no pay in it (empty, or $0) too. Null or missing: none. */
  pay?: number | null;
  /** What a hard landing took off that pay, in whole dollars, for the row's Safety Deductions cell; written only if that cell is empty and the Pilot Pay cell has no pay in it. Null or missing: none. */
  deduction?: number | null;
}

export interface ProfitFillResult {
  written: Array<{ sourceKey: string; cell: string; value: number }>;
  /** Pilot Pay cells written beside the profits, and how many were asked for but left alone because the cell has something in it (or there is no such column). */
  paid: Array<{ sourceKey: string; cell: string; value: number }>;
  payLeft: number;
  /** Safety Deductions cells written beside the pay, and how many were asked for but left alone (the cell has something in it, the pay cell has a pay, or there is no such column). */
  deducted: Array<{ sourceKey: string; cell: string; value: number }>;
  deductionLeft: number;
  /** Fills not written, and why: the row is gone or has moved, its pilot changed, it is not ticked as completed, or the cell is no longer blank. */
  skipped: Array<{ sourceKey: string; reason: 'gone' | 'moved' | 'changed' | 'not-completed' | 'filled' }>;
}

/** A Safety Deductions cell to write beside a pay that is already in the sheet, and what the row looked like when it was worked out. */
export interface DeductionWrite {
  sourceKey: string;
  /** Whole dollars. */
  value: number;
  /** The row and the pilot's name it had a moment ago: if either has changed since, nothing is written to it. */
  row: number;
  pilot: string;
  /** The Pilot Pay the sheet had then, in whole dollars (nothing at all, or $0, is 0): if the cell says anything else now, nothing is written. */
  pay: number;
}

export interface DeductionWriteResult {
  written: Array<{ sourceKey: string; cell: string; value: number }>;
  /** Deductions not written, and why: the row is gone or has moved, its pilot changed, it is not ticked as completed, the Pilot Pay is not what it was, or the cell has something in it now. */
  skipped: Array<{ sourceKey: string; reason: 'gone' | 'moved' | 'changed' | 'not-completed' | 'pay-changed' | 'filled' }>;
}

/** A flight whose Pilot Paid box is to be ticked, and what its row looked like when the pilot was paid. */
export interface PaidTick {
  sourceKey: string;
  /** The row and the pilot's name it had: if either has changed since, nothing is written to it. */
  row: number;
  pilot: string;
}

export interface PaidTickResult {
  /** Boxes ticked just now. */
  ticked: Array<{ sourceKey: string; cell: string }>;
  /** Boxes that were already ticked (nothing was written). */
  already: string[];
  /** Boxes left alone, and why: the row is gone or is another flight now, its pilot changed, it is not ticked as completed, or the cell holds something other than an empty box. */
  skipped: Array<{ sourceKey: string; reason: 'gone' | 'moved' | 'changed' | 'not-completed' | 'filled' }>;
}

interface Located {
  ref: SheetRef;
  title: string;
  row: number;
  pilotCell: string;
  doneCell: string;
  pilot: string;
  ticked: boolean;
  /** The flight's *Backup Pilot* cell, and what is in it. Null where the sheet has no such column. */
  backupCell: string | null;
  backup: string;
}

/**
 * Keeps the airline's Google Sheet in step with what pilots do here. It only ever touches three cells
 * of a flight's own row: the Pilot cell, the Flight Completed box and (where the sheet has one) the Backup Pilot cell. Before every write it reads
 * the tab afresh and finds the row again by the flight's route and date, so a sheet that has been
 * edited or re-sorted in the meantime is never written to blindly.
 *
 * Besides those it can write a blank Profit Made cell, and the pilot's pay in a blank (or $0) Pilot Pay cell beside it (and, where the airline asked, what a hard
 * landing took off that pay in an empty Safety Deductions cell), and only when an
 * admin has asked for exactly that and confirmed it (`fillProfits`, from `/setup profit`); and blank Distance and Flight Number cells (`fillDistances`,
 * `fillFlightNumbers`, as a schedule is read). It never changes any other cell that has anything in it.
 * The one more is the Pilot Paid box of a flight whose pilot has just been paid (`markPilotsPaid`, from `/payroll`), which it only ever ticks.
 */
/** A write to the sheet (its wait in line and its own time together) longer than this is noted in the log. */
const SLOW_WRITE_MS = 2_000;

export class SheetWriteBack {
  private readonly now: () => number;
  private readonly log: Logger;
  /**
   * Writes to one sheet's tab happen one at a time, so two pilots acting at once can't trample each other. Each tab has its own line: a pilot
   * of one airline is never kept waiting behind another airline's write, or behind a long fill of somebody else's sheet.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly api: SheetsPort,
    /** The service account's address: what a sheet owner shares the sheet with. */
    readonly accountEmail: string,
    opts: { now?: () => number; logger?: Logger } = {},
  ) {
    this.now = opts.now ?? appNow;
    this.log = opts.logger ?? silentLogger;
  }

  /** Will writes for this panel be attempted? */
  enabledFor(panel: Pick<Panel, 'writeback' | 'sheetId'>): boolean {
    return panel.writeback && panel.sheetId !== null;
  }

  /** Can the bot open the panel's sheet at all? Throws a WriteBackError saying why not. */
  async check(panel: Panel): Promise<void> {
    const ref = this.refOf(panel);
    try {
      await this.api.tabTitle(ref);
    } catch (e) {
      throw this.wrap(e);
    }
  }

  /** Put a pilot's name against a flight. Refuses if the sheet already names someone else. */
  claim(panel: Panel, sourceKey: string, name: string): Promise<void> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (at.ticked || isCancelled(at.pilot)) throw new WriteBackError('CLOSED', 'The sheet already shows that flight as completed or cancelled.');
      if (at.pilot === '') await this.write(at, [{ a1: at.pilotCell, value: name }]);
      else if (!same(at.pilot, name)) throw new WriteBackError('CONFLICT', `The sheet already names **${at.pilot}** for that flight.`, at.pilot);
    });
  }

  /** Take a pilot's name off a flight, but only if it is still the name we wrote. Returns whether it was cleared. */
  unclaim(panel: Panel, sourceKey: string, name: string): Promise<boolean> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (!same(at.pilot, name) || at.ticked) return false;
      await this.write(at, [{ a1: at.pilotCell, value: '' }]);
      return true;
    });
  }

  /** Change the name we wrote against a flight, but only if it is still the one we wrote. Returns whether it changed. */
  rename(panel: Panel, sourceKey: string, oldName: string, newName: string): Promise<boolean> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (!same(at.pilot, oldName) || at.ticked) return false;
      await this.write(at, [{ a1: at.pilotCell, value: newName }]);
      return true;
    });
  }

  /**
   * Put a backup pilot's name in the flight's *Backup Pilot* cell. Returns false, writing nothing, where the sheet has no such column. Refuses
   * if the flight is finished or cancelled, or if the cell already names someone else; a cell already holding this name is left as it is.
   */
  claimBackup(panel: Panel, sourceKey: string, name: string): Promise<boolean> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (at.backupCell === null) return false;
      if (at.ticked || isCancelled(at.pilot)) throw new WriteBackError('CLOSED', 'The sheet already shows that flight as completed or cancelled.');
      if (at.backup === '') await this.write(at, [{ a1: at.backupCell, value: name }]);
      else if (!same(at.backup, name)) throw new WriteBackError('CONFLICT', `The sheet already names **${at.backup}** as the backup for that flight.`, at.backup);
      return true;
    });
  }

  /** Take a backup pilot's name off a flight, but only if it is still the name we wrote. Returns whether it was cleared. */
  unclaimBackup(panel: Panel, sourceKey: string, name: string): Promise<boolean> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (at.backupCell === null || !same(at.backup, name) || at.ticked) return false;
      await this.write(at, [{ a1: at.backupCell, value: '' }]);
      return true;
    });
  }

  /** Change the backup pilot's name we wrote against a flight, but only if it is still the one we wrote. Returns whether it changed. */
  renameBackup(panel: Panel, sourceKey: string, oldName: string, newName: string): Promise<boolean> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (at.backupCell === null || !same(at.backup, oldName) || at.ticked) return false;
      await this.write(at, [{ a1: at.backupCell, value: newName }]);
      return true;
    });
  }

  /**
   * Tick a flight as completed, putting the pilot's name against it first if it has none. Refuses if
   * the sheet names someone else, or shows the flight as cancelled. If the box is already ticked
   * there is nothing to write.
   */
  complete(panel: Panel, sourceKey: string, name: string): Promise<void> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (isCancelled(at.pilot)) throw new WriteBackError('CLOSED', 'The sheet shows that flight as cancelled.');
      const cells: Cell[] = [];
      if (at.pilot === '') cells.push({ a1: at.pilotCell, value: name });
      else if (!same(at.pilot, name)) throw new WriteBackError('CONFLICT', `The sheet names **${at.pilot}** for that flight, so I haven't ticked it.`, at.pilot);
      if (!at.ticked) cells.push({ a1: at.doneCell, value: true });
      await this.write(at, cells);
    });
  }

  /**
   * Complete a flight for its backup pilot, who flew it in place of the pilot: the Pilot cell takes the backup's name, the Flight Completed box is
   * ticked, and the backup's own name comes off the Backup Pilot cell, all in one write. The Pilot cell is only changed if it is empty or still holds
   * `from` (the name this bot wrote for the pilot); a cell that names anyone else is never replaced. Refuses if the flight is cancelled or already
   * shown as completed. Returns whether the backup's name was taken off the Backup Pilot cell (only where it still held `backupName`, the name this bot wrote).
   */
  completeAsBackup(panel: Panel, sourceKey: string, change: { from: string | null; to: string; backupName: string | null }): Promise<{ backupCleared: boolean }> {
    return this.serial(panel, async () => {
      const at = await this.locate(panel, sourceKey);
      if (isCancelled(at.pilot)) throw new WriteBackError('CLOSED', 'The sheet shows that flight as cancelled.');
      if (at.ticked) throw new WriteBackError('CLOSED', 'The sheet already shows that flight as completed.');
      const cells: Cell[] = [];
      if (at.pilot === '' || (change.from !== null && same(at.pilot, change.from))) cells.push({ a1: at.pilotCell, value: change.to });
      else if (!same(at.pilot, change.to)) throw new WriteBackError('CONFLICT', `The sheet names **${at.pilot}** for that flight, so I haven't changed it.`, at.pilot);
      cells.push({ a1: at.doneCell, value: true });
      const backupCleared = at.backupCell !== null && change.backupName !== null && same(at.backup, change.backupName);
      if (backupCleared) cells.push({ a1: at.backupCell as string, value: '' });
      await this.write(at, cells);
      return { backupCleared };
    });
  }

  /**
   * Write profits into Profit Made cells, but only the blank ones. The tab is read afresh, and each flight is found again by its key; a
   * profit is written only if its row is where it was, still names the same pilot, is ticked as completed, and the cell is still empty.
   * Anything else is left alone and said so in the result. Nothing that is already in a cell is ever replaced.
   */
  fillProfits(panel: Panel, fills: ProfitFill[]): Promise<ProfitFillResult> {
    return this.serial(panel, async () => {
      const ref = this.refOf(panel);
      const result: ProfitFillResult = { written: [], paid: [], payLeft: 0, deducted: [], deductionLeft: 0, skipped: [] };
      try {
        const tab = await this.api.readTab(ref);
        // What is really in the cells as well as what they show: a cell with a formula that shows nothing is still filled in.
        const stored = await this.api.readTab(ref, 'FORMULA');
        // Every row of the tab, old ones included: the check that offered these fills read every row, and a flight a manager has not entered the
        // profit for yet is as likely to be last week's as yesterday's. (Without this, a row more than three days past its window was "gone".)
        const parsed = parseScheduleValues(tab.values, this.now(), true);
        if (!parsed || parsed.cols.pilot < 0 || parsed.cols.done < 0) throw new WriteBackError('NO_COLUMNS', "I couldn't find the Pilot and Flight Completed columns in that sheet.");
        if (parsed.cols.profit < 0) throw new WriteBackError('NO_COLUMNS', "I couldn't find a Profit Made column in that sheet.");
        const cells: Cell[] = [];
        for (const fill of fills) {
          const row = parsed.rowOf.get(fill.sourceKey);
          if (row === undefined) {
            result.skipped.push({ sourceKey: fill.sourceKey, reason: 'gone' });
            continue;
          }
          if (row !== fill.row) {
            result.skipped.push({ sourceKey: fill.sourceKey, reason: 'moved' });
            continue;
          }
          const values = tab.values[row - 1] ?? [];
          const pilot = (values[parsed.cols.pilot] ?? '').trim();
          if (!same(pilot, fill.pilot)) {
            result.skipped.push({ sourceKey: fill.sourceKey, reason: 'changed' });
            continue;
          }
          if (!isTicked(values[parsed.cols.done] ?? '') || isCancelled(pilot)) {
            result.skipped.push({ sourceKey: fill.sourceKey, reason: 'not-completed' });
            continue;
          }
          // Empty means empty: not a space, not a note, not a formula, not a zero. Anything at all in the cell, and it is left exactly as it is.
          if ((values[parsed.cols.profit] ?? '') !== '' || (stored.values[row - 1]?.[parsed.cols.profit] ?? '') !== '') {
            result.skipped.push({ sourceKey: fill.sourceKey, reason: 'filled' });
            continue;
          }
          const a1 = `${colLetter(parsed.cols.profit)}${row}`;
          cells.push({ a1, value: fill.value });
          result.written.push({ sourceKey: fill.sourceKey, cell: a1, value: fill.value });
          // The pilot's pay goes in beside it, but only into a Pilot Pay cell with no pay in it: nothing at all, or a plain zero (a column formatted
          // as money shows $0 for an empty cell). Both what it shows and what is stored in it must say so; a figure above zero, a note, a stray
          // space or a formula (even one that works out to zero) is somebody's and is left exactly as it is.
          const payEmpty = parsed.cols.pay >= 0 && isUnsetPay(values[parsed.cols.pay]) && isUnsetPay(stored.values[row - 1]?.[parsed.cols.pay]);
          if (fill.pay !== undefined && fill.pay !== null) {
            if (payEmpty) {
              const payCell = `${colLetter(parsed.cols.pay)}${row}`;
              cells.push({ a1: payCell, value: fill.pay });
              result.paid.push({ sourceKey: fill.sourceKey, cell: payCell, value: fill.pay });
            } else result.payLeft++;
          }
          // What the hard landing took off goes in the Safety Deductions cell beside it, on the same terms: only beside a Pilot Pay with no pay in it (the
          // deduction is the reason for the pay this bot works out, not something to put next to a pay somebody else set), and only into an empty cell.
          if (fill.deduction !== undefined && fill.deduction !== null && fill.deduction > 0) {
            const free = payEmpty && parsed.cols.deduction >= 0 && isUnsetPay(values[parsed.cols.deduction]) && isUnsetPay(stored.values[row - 1]?.[parsed.cols.deduction]);
            if (free) {
              const cell = `${colLetter(parsed.cols.deduction)}${row}`;
              cells.push({ a1: cell, value: fill.deduction });
              result.deducted.push({ sourceKey: fill.sourceKey, cell, value: fill.deduction });
            } else result.deductionLeft++;
          }
        }
        if (cells.length > 0) {
          await this.api.update(ref, tab.title, cells);
          this.log.info(`Wrote ${result.written.length} blank Profit Made cell${result.written.length === 1 ? '' : 's'} and ${result.paid.length} blank Pilot Pay cell${result.paid.length === 1 ? '' : 's'} in the airline's sheet (asked for by an admin): ${cells.map((c) => c.a1).join(', ')}`);
        }
        return result;
      } catch (e) {
        throw this.wrap(e);
      }
    });
  }

  /**
   * Write Safety Deductions beside pay that is already in the sheet (for flights filled in before deductions were switched on). The tab is read afresh, twice
   * (what the cells show and what is stored in them), and each deduction is written only if its row is where it was, still names the same pilot, is ticked as
   * completed, still has the Pilot Pay it had (exactly: a deduction is only true beside that pay) and the Safety Deductions cell is empty (nothing, or $0).
   * Anything else is left alone and said so in the result. It touches no other cell, and replaces nothing.
   */
  fillDeductions(panel: Panel, writes: DeductionWrite[]): Promise<DeductionWriteResult> {
    return this.serial(panel, async () => {
      const result: DeductionWriteResult = { written: [], skipped: [] };
      if (writes.length === 0) return result;
      const ref = this.refOf(panel);
      try {
        const tab = await this.api.readTab(ref);
        const stored = await this.api.readTab(ref, 'FORMULA');
        const parsed = parseScheduleValues(tab.values, this.now(), true);
        if (!parsed || parsed.cols.pilot < 0 || parsed.cols.done < 0) throw new WriteBackError('NO_COLUMNS', "I couldn't find the Pilot and Flight Completed columns in that sheet.");
        if (parsed.cols.pay < 0) throw new WriteBackError('NO_COLUMNS', "I couldn't find a Pilot Pay column in that sheet.");
        if (parsed.cols.deduction < 0) throw new WriteBackError('NO_COLUMNS', "I couldn't find a Safety Deductions column in that sheet.");
        const cells: Cell[] = [];
        /** The dollars a pay cell holds, as it shows and as it is stored: nothing at all or $0 is 0; a note or a formula is no amount. */
        const payOf = (shown: string | undefined, kept: string | undefined): number | null => {
          const a = isUnsetPay(shown) ? 0 : parseMoney(shown);
          const b = isUnsetPay(kept) ? 0 : parseMoney(kept);
          return a !== null && a === b ? a : null;
        };
        for (const w of writes) {
          const row = parsed.rowOf.get(w.sourceKey);
          if (row === undefined) {
            result.skipped.push({ sourceKey: w.sourceKey, reason: 'gone' });
            continue;
          }
          if (row !== w.row) {
            result.skipped.push({ sourceKey: w.sourceKey, reason: 'moved' });
            continue;
          }
          const values = tab.values[row - 1] ?? [];
          const pilot = (values[parsed.cols.pilot] ?? '').trim();
          if (!same(pilot, w.pilot)) {
            result.skipped.push({ sourceKey: w.sourceKey, reason: 'changed' });
            continue;
          }
          if (!isTicked(values[parsed.cols.done] ?? '') || isCancelled(pilot)) {
            result.skipped.push({ sourceKey: w.sourceKey, reason: 'not-completed' });
            continue;
          }
          if (payOf(values[parsed.cols.pay], stored.values[row - 1]?.[parsed.cols.pay]) !== w.pay) {
            result.skipped.push({ sourceKey: w.sourceKey, reason: 'pay-changed' });
            continue;
          }
          if (!isUnsetPay(values[parsed.cols.deduction]) || !isUnsetPay(stored.values[row - 1]?.[parsed.cols.deduction])) {
            result.skipped.push({ sourceKey: w.sourceKey, reason: 'filled' });
            continue;
          }
          const a1 = `${colLetter(parsed.cols.deduction)}${row}`;
          cells.push({ a1, value: w.value });
          result.written.push({ sourceKey: w.sourceKey, cell: a1, value: w.value });
        }
        if (cells.length > 0) {
          await this.api.update(ref, tab.title, cells);
          this.log.info(`Wrote ${result.written.length} blank Safety Deductions cell${result.written.length === 1 ? '' : 's'} in the airline's sheet (asked for by an admin)`);
        }
        return result;
      } catch (e) {
        throw this.wrap(e);
      }
    });
  }

  /**
   * Tick the Pilot Paid box of flights whose pilot has just been paid. The tab is read afresh, twice (what the cells show and what is stored
   * in them), and each row is checked before its box is touched: it is still the same flight (its route and date), still names the same pilot,
   * is ticked as completed, and the Pilot Paid cell is an empty box (nothing in it, or FALSE). A box that is already ticked is left as it is,
   * and a cell with anything else in it (a note, a formula) is never replaced. A box is only ever ticked: this never unticks one, and it
   * touches no other cell. Nothing is asked of Google when there is nothing to tick.
   */
  markPilotsPaid(panel: Panel, ticks: PaidTick[]): Promise<PaidTickResult> {
    return this.serial(panel, async () => {
      const result: PaidTickResult = { ticked: [], already: [], skipped: [] };
      if (ticks.length === 0) return result;
      const ref = this.refOf(panel);
      try {
        const tab = await this.api.readTab(ref);
        const stored = await this.api.readTab(ref, 'FORMULA');
        const header = findHeader(tab.values);
        const at = (pred: (n: string) => boolean) => (header ? header.names.findIndex(pred) : -1);
        const iRoute = at((n) => n === 'route');
        const iDate = at((n) => n === 'date');
        const iPilot = at((n) => n === 'pilot');
        const iDone = at((n) => n.startsWith('flightcompleted') || n === 'completed');
        const iPaid = at((n) => PAID_COLUMNS.includes(n));
        if (iRoute < 0 || iDate < 0 || iPilot < 0 || iDone < 0) throw new WriteBackError('NO_COLUMNS', "I couldn't find the Route, Date, Pilot and Flight Completed columns in that sheet.");
        if (iPaid < 0) throw new WriteBackError('NO_COLUMNS', "I couldn't find a Pilot Paid column in that sheet.");
        const cells: Cell[] = [];
        for (const t of ticks) {
          const values = tab.values[t.row - 1];
          if (!values) {
            result.skipped.push({ sourceKey: t.sourceKey, reason: 'gone' });
            continue;
          }
          // The same flight is still on that row: a key is the route and the date (a repeat of them on a later row only adds `#2`).
          const legs = parseLegChain((values[iRoute] ?? '').trim());
          const day = parseSheetDate(values[iDate] ?? '');
          const key = typeof legs !== 'string' && day ? `${legs.map((l) => `${l.dep}-${l.arr}`).join('+')}@${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}` : null;
          if (key !== t.sourceKey.split('#')[0]) {
            result.skipped.push({ sourceKey: t.sourceKey, reason: 'moved' });
            continue;
          }
          const pilot = (values[iPilot] ?? '').trim();
          if (!same(pilot, t.pilot)) {
            result.skipped.push({ sourceKey: t.sourceKey, reason: 'changed' });
            continue;
          }
          if (!isTicked(values[iDone] ?? '') || isCancelled(pilot)) {
            result.skipped.push({ sourceKey: t.sourceKey, reason: 'not-completed' });
            continue;
          }
          const shown = (values[iPaid] ?? '').trim();
          const kept = (stored.values[t.row - 1]?.[iPaid] ?? '').trim();
          if (isTicked(shown) && isTicked(kept)) {
            result.already.push(t.sourceKey);
            continue;
          }
          // An empty box is a cell with nothing in it or FALSE, as it shows and as it is stored. Anything else is somebody's, and is left alone.
          const empty = (v: string) => v === '' || v.toUpperCase() === 'FALSE';
          if (!empty(shown) || !empty(kept)) {
            result.skipped.push({ sourceKey: t.sourceKey, reason: 'filled' });
            continue;
          }
          const a1 = `${colLetter(iPaid)}${t.row}`;
          cells.push({ a1, value: true });
          result.ticked.push({ sourceKey: t.sourceKey, cell: a1 });
        }
        if (cells.length > 0) {
          await this.api.update(ref, tab.title, cells);
          this.log.info(`Ticked ${cells.length} Pilot Paid box${cells.length === 1 ? '' : 'es'} in the airline's sheet (pilots were paid): ${cells.map((c) => c.a1).join(', ')}`);
        }
        return result;
      } catch (e) {
        throw this.wrap(e);
      }
    });
  }

  /**
   * Write each flight's distance (nautical miles, a number) into its Distance cell, but only where that cell has nothing in it. The tab is
   * read afresh, twice (what the cells show and what is stored in them, so a formula that shows nothing still counts as filled), and each
   * flight is found again by its key; a flight that is gone is skipped. Nothing that is already in a cell is ever replaced, and nothing
   * is asked of Google when there is nothing to write. Returns how many cells were written.
   */
  fillDistances(panel: Panel, plan: Array<{ sourceKey: string; nm: number }>): Promise<{ written: number }> {
    return this.serial(panel, async () => {
      if (plan.length === 0) return { written: 0 };
      const ref = this.refOf(panel);
      try {
        const tab = await this.api.readTab(ref);
        const stored = await this.api.readTab(ref, 'FORMULA');
        const parsed = parseScheduleValues(tab.values, this.now());
        if (!parsed || parsed.cols.distance < 0) return { written: 0 };
        const col = parsed.cols.distance;
        const cells: Cell[] = [];
        const rows: number[] = [];
        let gone = 0;
        let filled = 0;
        for (const item of plan) {
          const row = parsed.rowOf.get(item.sourceKey);
          if (row === undefined) {
            gone++;
            continue;
          }
          if ((tab.values[row - 1]?.[col] ?? '') !== '' || (stored.values[row - 1]?.[col] ?? '') !== '') {
            filled++;
            continue;
          }
          cells.push({ a1: `${colLetter(col)}${row}`, value: item.nm });
          rows.push(row);
        }
        if (DEBUG_BUILD) dbg(this.log, `distances: ${plan.length} planned; ${cells.length} cell(s) to write${gone > 0 ? `; ${gone} no longer in the sheet` : ''}${filled > 0 ? `; ${filled} already have something in the cell` : ''}`);
        if (cells.length > 0) {
          // What a number looks like is up to the cell's format, so look at it first. This comes before the write: if it fails, nothing has been
          // written, and a distance never lands in a cell that would show it as a date.
          const formats = await this.api.columnNumberFormats(ref, tab.title, col, Math.min(...rows), Math.max(...rows));
          const misleading = rows.filter((r) => MISLEADING_FORMATS.has(formats.types.get(r) ?? ''));
          if (DEBUG_BUILD) dbg(this.log, `distances: number formats of the cells to write: ${[...new Set(rows.map((r) => formats.types.get(r) ?? 'none'))].join(', ')}; ${misleading.length} would show a distance as something else${misleading.length > 0 ? ' and get a plain number format' : ''}`);
          if (misleading.length > 0) await this.api.setNumberFormat(ref, formats.sheetId, col, misleading, DISTANCE_FORMAT);
          await this.api.update(ref, tab.title, cells);
          this.log.info(`Wrote ${cells.length} blank Distance cell${cells.length === 1 ? '' : 's'} in the airline's sheet: ${cells.map((c) => c.a1).join(', ')}${misleading.length > 0 ? ` (${misleading.length} of them were formatted as dates, money or the like, and were given a plain number format)` : ''}`);
        }
        return { written: cells.length };
      } catch (e) {
        throw this.wrap(e);
      }
    });
  }

  /**
   * Write each flight's own flight number into its Flight Number cell, but only where that cell has nothing in it. The tab is read afresh, twice
   * (what the cells show and what is stored in them, so a formula that shows nothing still counts as filled), and every row of it is looked at, however
   * long ago it was flown. `numbersFor` is given the rows whose cell is empty and returns the number for each (null where it cannot say). A number is
   * never written to a row when another row for the same flight (the same two airports on the same day) already shows that number, and nothing that is
   * already in a cell is ever replaced. Nothing is asked of Google when there is nothing to write. Returns how many cells were written.
   */
  fillFlightNumbers(panel: Panel, numbersFor: (rows: NumberlessRow[]) => Array<string | null>): Promise<{ written: number }> {
    return this.serial(panel, async () => {
      const ref = this.refOf(panel);
      try {
        const tab = await this.api.readTab(ref);
        const stored = await this.api.readTab(ref, 'FORMULA');
        const parsed = parseScheduleValues(tab.values, this.now(), true);
        if (!parsed || parsed.cols.flightNo < 0) return { written: 0 };
        const col = parsed.cols.flightNo;
        const blank = (parsed.blankFlightNumbers ?? []).filter((r) => {
          const row = parsed.rowOf.get(r.key);
          return row !== undefined && (stored.values[row - 1]?.[col] ?? '') === '';
        });
        if (blank.length === 0) return { written: 0 };
        const shown = new Set<string>();
        for (const [key, row] of parsed.rowOf) {
          const number = normalizeFlightNumber(tab.values[row - 1]?.[col] ?? '');
          if (number) shown.add(`${key.split('#')[0]}|${number}`);
        }
        const numbers = numbersFor(blank);
        const cells: Cell[] = [];
        blank.forEach((r, i) => {
          const number = numbers[i];
          const row = parsed.rowOf.get(r.key);
          if (!number || row === undefined || shown.has(`${r.key.split('#')[0]}|${number}`)) return;
          cells.push({ a1: `${colLetter(col)}${row}`, value: number });
        });
        if (cells.length > 0) {
          await this.api.update(ref, tab.title, cells);
          this.log.info(`Wrote ${cells.length} blank Flight Number cell${cells.length === 1 ? '' : 's'} in the airline's sheet: ${cells.map((c) => c.a1).join(', ')}`);
        }
        return { written: cells.length };
      } catch (e) {
        throw this.wrap(e);
      }
    });
  }

  /* ------------------------------------------------------------------ internals */

  private serial<T>(panel: Pick<Panel, 'sheetId' | 'sheetGid'>, work: () => Promise<T>): Promise<T> {
    const key = `${panel.sheetId ?? ''}#${panel.sheetGid ?? ''}`;
    const queuedAt = realMs();
    let startedAt = queuedAt;
    const timed = async (): Promise<T> => {
      startedAt = realMs();
      try {
        return await work();
      } finally {
        // What a person waits for, said in the log when it was long: how much of it was waiting in line, and how much was the work itself.
        const waited = startedAt - queuedAt;
        const took = realMs() - startedAt;
        if (waited + took >= SLOW_WRITE_MS) this.log.info(`Slow: a write to the airline's sheet waited ${(waited / 1000).toFixed(1)} s in line and took ${(took / 1000).toFixed(1)} s`);
      }
    };
    const run = (this.queues.get(key) ?? Promise.resolve()).then(timed, timed);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    // A tab with nothing waiting leaves no entry behind.
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  /** Resolves once every write that is under way or waiting has finished (for a tidy shutdown, so a write is not cut off half done, and for tests). */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  private refOf(panel: Panel): SheetRef {
    const ref = sheetRefOf(panel);
    if (!ref) throw new WriteBackError('NO_SHEET', "This panel isn't linked to a Google Sheet.");
    return ref;
  }

  private wrap(e: unknown): WriteBackError {
    if (e instanceof WriteBackError) return e;
    if (e instanceof SheetsError) return new WriteBackError('GOOGLE', e.message);
    this.log.warn('Unexpected error talking to Google Sheets', e);
    return new WriteBackError('GOOGLE', 'Something went wrong talking to Google Sheets.');
  }

  /** Read the tab now and find the flight's row, its Pilot cell and its Completed box. */
  private async locate(panel: Panel, sourceKey: string): Promise<Located> {
    const ref = this.refOf(panel);
    try {
      const tab = await this.api.readTab(ref);
      const parsed = parseScheduleValues(tab.values, this.now());
      if (!parsed || parsed.cols.pilot < 0 || parsed.cols.done < 0) {
        this.api.forgetTab?.(ref); // the sheet is not what was expected: do not trust the tab's name kept from before
        throw new WriteBackError('NO_COLUMNS', "I couldn't find the Pilot and Flight Completed columns in that sheet.");
      }
      const row = parsed.rowOf.get(sourceKey);
      if (row === undefined) {
        this.api.forgetTab?.(ref);
        throw new WriteBackError('FLIGHT_NOT_FOUND', "I can't find that flight in the sheet any more. Its row may have been changed or removed.");
      }
      const cells = tab.values[row - 1] ?? [];
      const iBackup = findHeader(tab.values)?.names.findIndex((n) => n === 'backuppilot') ?? -1;
      return {
        ref,
        title: tab.title,
        row,
        pilotCell: `${colLetter(parsed.cols.pilot)}${row}`,
        doneCell: `${colLetter(parsed.cols.done)}${row}`,
        pilot: (cells[parsed.cols.pilot] ?? '').trim(),
        ticked: isTicked(cells[parsed.cols.done] ?? ''),
        backupCell: iBackup >= 0 ? `${colLetter(iBackup)}${row}` : null,
        backup: iBackup >= 0 ? (cells[iBackup] ?? '').trim() : '',
      };
    } catch (e) {
      throw this.wrap(e);
    }
  }

  private async write(at: Located, cells: Cell[]): Promise<void> {
    if (cells.length === 0) return;
    try {
      await this.api.update(at.ref, at.title, cells);
      this.log.info(`Wrote ${cells.map((c) => c.a1).join(', ')} in the airline's sheet`);
      if (DEBUG_BUILD) dbg(this.log, `write-back: ${at.title} ${cells.map((c) => `${c.a1}=${JSON.stringify(c.value)}`).join(', ')} (was pilot "${at.pilot}", ticked ${at.ticked}) via ${callerPath(2, 5)}`);
    } catch (e) {
      throw this.wrap(e);
    }
  }
}
