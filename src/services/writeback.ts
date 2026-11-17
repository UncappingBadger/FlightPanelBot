import type { Panel } from '../db/store.js';
import { SheetsError, type Cell, type SheetsApi } from '../google/sheetsApi.js';
import { colLetter, isCancelled, isTicked, parseScheduleValues, sheetRefOf, type SheetRef } from '../jobs/sheet.js';
import { DEBUG_BUILD, callerPath, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';

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

/** A profit to write into a blank Profit Made cell, and what the row looked like when the profit was worked out. */
export interface ProfitFill {
  sourceKey: string;
  /** Whole dollars, as the sheet is kept. */
  value: number;
  /** The row and the pilot's name it had a moment ago: if either has changed since, nothing is written to it. */
  row: number;
  pilot: string;
  /** What the pilot is paid for the flight, in whole dollars, for the row's Pilot Pay cell; written only if that cell is empty too. Null or missing: none. */
  pay?: number | null;
}

export interface ProfitFillResult {
  written: Array<{ sourceKey: string; cell: string; value: number }>;
  /** Pilot Pay cells written beside the profits, and how many were asked for but left alone because the cell has something in it (or there is no such column). */
  paid: Array<{ sourceKey: string; cell: string; value: number }>;
  payLeft: number;
  /** Fills not written, and why: the row is gone or has moved, its pilot changed, it is not ticked as completed, or the cell is no longer blank. */
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
}

/**
 * Keeps the airline's Google Sheet in step with what pilots do here. It only ever touches two cells
 * of a flight's own row: the Pilot cell and the Flight Completed box. Before every write it reads
 * the tab afresh and finds the row again by the flight's route and date, so a sheet that has been
 * edited or re-sorted in the meantime is never written to blindly.
 *
 * The one other thing it can write is a blank Profit Made cell, and the pilot's pay in a blank Pilot Pay cell beside it, and only when an
 * admin has asked for exactly that and confirmed it (`fillProfits`, from `/setup profit`). It never changes a cell that has anything in it.
 */
export class SheetWriteBack {
  private readonly now: () => number;
  private readonly log: Logger;
  /** Writes happen one at a time, so two pilots acting at once can't trample each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: SheetsApi,
    /** The service account's address: what a sheet owner shares the sheet with. */
    readonly accountEmail: string,
    opts: { now?: () => number; logger?: Logger } = {},
  ) {
    this.now = opts.now ?? Date.now;
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
    return this.serial(async () => {
      const at = await this.locate(panel, sourceKey);
      if (at.ticked || isCancelled(at.pilot)) throw new WriteBackError('CLOSED', 'The sheet already shows that flight as completed or cancelled.');
      if (at.pilot === '') await this.write(at, [{ a1: at.pilotCell, value: name }]);
      else if (!same(at.pilot, name)) throw new WriteBackError('CONFLICT', `The sheet already names **${at.pilot}** for that flight.`, at.pilot);
    });
  }

  /** Take a pilot's name off a flight, but only if it is still the name we wrote. Returns whether it was cleared. */
  unclaim(panel: Panel, sourceKey: string, name: string): Promise<boolean> {
    return this.serial(async () => {
      const at = await this.locate(panel, sourceKey);
      if (!same(at.pilot, name) || at.ticked) return false;
      await this.write(at, [{ a1: at.pilotCell, value: '' }]);
      return true;
    });
  }

  /** Change the name we wrote against a flight, but only if it is still the one we wrote. Returns whether it changed. */
  rename(panel: Panel, sourceKey: string, oldName: string, newName: string): Promise<boolean> {
    return this.serial(async () => {
      const at = await this.locate(panel, sourceKey);
      if (!same(at.pilot, oldName) || at.ticked) return false;
      await this.write(at, [{ a1: at.pilotCell, value: newName }]);
      return true;
    });
  }

  /**
   * Tick a flight as completed, putting the pilot's name against it first if it has none. Refuses if
   * the sheet names someone else, or shows the flight as cancelled. If the box is already ticked
   * there is nothing to write.
   */
  complete(panel: Panel, sourceKey: string, name: string): Promise<void> {
    return this.serial(async () => {
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
   * Write profits into Profit Made cells, but only the blank ones. The tab is read afresh, and each flight is found again by its key; a
   * profit is written only if its row is where it was, still names the same pilot, is ticked as completed, and the cell is still empty.
   * Anything else is left alone and said so in the result. Nothing that is already in a cell is ever replaced.
   */
  fillProfits(panel: Panel, fills: ProfitFill[]): Promise<ProfitFillResult> {
    return this.serial(async () => {
      const ref = this.refOf(panel);
      const result: ProfitFillResult = { written: [], paid: [], payLeft: 0, skipped: [] };
      try {
        const tab = await this.api.readTab(ref);
        // What is really in the cells as well as what they show: a cell with a formula that shows nothing is still filled in.
        const stored = await this.api.readTab(ref, 'FORMULA');
        const parsed = parseScheduleValues(tab.values, this.now());
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
          // The pilot's pay goes in beside it, on the same terms: only into a Pilot Pay cell with nothing in it at all.
          if (fill.pay !== undefined && fill.pay !== null) {
            const empty = parsed.cols.pay >= 0 && (values[parsed.cols.pay] ?? '') === '' && (stored.values[row - 1]?.[parsed.cols.pay] ?? '') === '';
            if (empty) {
              const payCell = `${colLetter(parsed.cols.pay)}${row}`;
              cells.push({ a1: payCell, value: fill.pay });
              result.paid.push({ sourceKey: fill.sourceKey, cell: payCell, value: fill.pay });
            } else result.payLeft++;
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
   * Write each flight's distance (nautical miles, a number) into its Distance cell, but only where that cell has nothing in it. The tab is
   * read afresh, twice (what the cells show and what is stored in them, so a formula that shows nothing still counts as filled), and each
   * flight is found again by its key; a flight that is gone is skipped. Nothing that is already in a cell is ever replaced, and nothing
   * is asked of Google when there is nothing to write. Returns how many cells were written.
   */
  fillDistances(panel: Panel, plan: Array<{ sourceKey: string; nm: number }>): Promise<{ written: number }> {
    return this.serial(async () => {
      if (plan.length === 0) return { written: 0 };
      const ref = this.refOf(panel);
      try {
        const tab = await this.api.readTab(ref);
        const stored = await this.api.readTab(ref, 'FORMULA');
        const parsed = parseScheduleValues(tab.values, this.now());
        if (!parsed || parsed.cols.distance < 0) return { written: 0 };
        const col = parsed.cols.distance;
        const cells: Cell[] = [];
        for (const item of plan) {
          const row = parsed.rowOf.get(item.sourceKey);
          if (row === undefined) continue;
          if ((tab.values[row - 1]?.[col] ?? '') !== '' || (stored.values[row - 1]?.[col] ?? '') !== '') continue;
          cells.push({ a1: `${colLetter(col)}${row}`, value: item.nm });
        }
        if (cells.length > 0) {
          await this.api.update(ref, tab.title, cells);
          this.log.info(`Wrote ${cells.length} blank Distance cell${cells.length === 1 ? '' : 's'} in the airline's sheet: ${cells.map((c) => c.a1).join(', ')}`);
        }
        return { written: cells.length };
      } catch (e) {
        throw this.wrap(e);
      }
    });
  }

  /* ------------------------------------------------------------------ internals */

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
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
        throw new WriteBackError('NO_COLUMNS', "I couldn't find the Pilot and Flight Completed columns in that sheet.");
      }
      const row = parsed.rowOf.get(sourceKey);
      if (row === undefined) throw new WriteBackError('FLIGHT_NOT_FOUND', "I can't find that flight in the sheet any more. Its row may have been changed or removed.");
      const cells = tab.values[row - 1] ?? [];
      return {
        ref,
        title: tab.title,
        row,
        pilotCell: `${colLetter(parsed.cols.pilot)}${row}`,
        doneCell: `${colLetter(parsed.cols.done)}${row}`,
        pilot: (cells[parsed.cols.pilot] ?? '').trim(),
        ticked: isTicked(cells[parsed.cols.done] ?? ''),
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
