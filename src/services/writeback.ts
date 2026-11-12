import type { Panel } from '../db/store.js';
import { SheetsError, type Cell, type SheetsApi } from '../google/sheetsApi.js';
import { colLetter, isCancelled, isTicked, parseScheduleValues, sheetRefOf, type SheetRef } from '../jobs/sheet.js';
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
    } catch (e) {
      throw this.wrap(e);
    }
  }
}
