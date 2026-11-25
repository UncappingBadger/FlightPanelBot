import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from '../jobs/import.js';
import { colLetter, downloadSheetCsv, type SheetRef } from '../jobs/sheet.js';
import { silentLogger, type Logger } from '../util/log.js';
import { SheetsError, type Cell, type SheetsPort } from './sheetsApi.js';

/**
 * A sheet kept in a local file, for the diagnostic build. The build never writes to Google: the schedule is copied once from the sheet's
 * public CSV export, and from then on the bot reads that file and writes into it, so what it writes can be opened and checked, and what it
 * wrote is what it reads back next time. One file per sheet and tab, in one folder; delete a file to take a fresh copy from Google.
 *
 * A number format cannot be kept in a CSV, so the formats of cells live in a small file beside it (`<file>.formats.json`, cell address to
 * `{ "type": "DATE" }`), which can be written by hand to try how the bot treats a cell that would show a number as a date.
 */

/** The local file a sheet's tab is kept in. */
export function localSheetFile(dir: string, ref: SheetRef): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return join(dir, `${safe(ref.id)}_${ref.gid ?? 'first'}.csv`);
}

export const csvField = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: string[][]): string => `${rows.map((r) => r.map(csvField).join(',')).join('\r\n')}\r\n`;
const colIndex = (letters: string): number => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** Write a file in one piece, so a program reading it never sees half of it. */
export function saveAtomically(file: string, text: string): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, file);
}

export class LocalSheet implements SheetsPort {
  constructor(
    private readonly dir: string,
    private readonly log: Logger = silentLogger,
  ) {}

  private rowsOf(ref: SheetRef): string[][] {
    const file = localSheetFile(this.dir, ref);
    if (!existsSync(file)) throw new SheetsError('NOT_FOUND', 'There is no local copy of that sheet yet: the bot makes one the first time it reads the schedule.');
    return parseCsv(readFileSync(file, 'utf8'), { keepBlankRows: true });
  }

  private formatsFile(ref: SheetRef): string {
    return `${localSheetFile(this.dir, ref)}.formats.json`;
  }

  private formatsOf(ref: SheetRef): Record<string, { type?: string; pattern?: string }> {
    try {
      const raw = JSON.parse(readFileSync(this.formatsFile(ref), 'utf8'));
      return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  async tabTitle(_ref: SheetRef): Promise<string> {
    return 'Local sheet';
  }

  /** The tab as the real API gives it: every cell as text, with empty trailing cells and rows left off. A local file has no formulas. */
  async readTab(ref: SheetRef, _render: 'FORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE'): Promise<{ title: string; values: string[][] }> {
    const rows = this.rowsOf(ref).map((r) => {
      const out = [...r];
      while (out.length > 0 && out.at(-1) === '') out.pop();
      return out;
    });
    while (rows.length > 0 && rows.at(-1)!.length === 0) rows.pop();
    return { title: 'Local sheet', values: rows };
  }

  async update(ref: SheetRef, _title: string, cells: Cell[]): Promise<void> {
    if (cells.length === 0) return;
    const rows = this.rowsOf(ref);
    for (const c of cells) {
      const m = /^([A-Z]+)(\d+)$/.exec(c.a1);
      if (!m) throw new SheetsError('NOT_FOUND', `${c.a1} is not a cell.`);
      const row = Number(m[2]) - 1;
      const col = colIndex(m[1] as string);
      while (rows.length <= row) rows.push([]);
      const cellsOfRow = rows[row] as string[];
      while (cellsOfRow.length <= col) cellsOfRow.push('');
      cellsOfRow[col] = typeof c.value === 'boolean' ? (c.value ? 'TRUE' : 'FALSE') : String(c.value);
    }
    saveAtomically(localSheetFile(this.dir, ref), toCsv(rows));
    this.log.info(`Local sheet: wrote ${cells.map((c) => `${c.a1}=${JSON.stringify(c.value)}`).join(', ')}`);
  }

  async columnNumberFormats(ref: SheetRef, _title: string, col: number, firstRow: number, lastRow: number): Promise<{ sheetId: number; types: Map<number, string> }> {
    const formats = this.formatsOf(ref);
    const types = new Map<number, string>();
    for (let r = firstRow; r <= lastRow; r++) {
      const type = formats[`${colLetter(col)}${r}`]?.type;
      if (typeof type === 'string') types.set(r, type);
    }
    return { sheetId: 0, types };
  }

  async setNumberFormat(ref: SheetRef, _sheetId: number, col: number, rows: number[], format: { type: string; pattern: string }): Promise<void> {
    const formats = this.formatsOf(ref);
    for (const r of rows) formats[`${colLetter(col)}${r}`] = { type: format.type, pattern: format.pattern };
    saveAtomically(this.formatsFile(ref), `${JSON.stringify(formats, null, 1)}\n`);
    this.log.info(`Local sheet: gave ${rows.length} cell${rows.length === 1 ? '' : 's'} of column ${colLetter(col)} the number format ${format.type} ${format.pattern} (rows ${rows.join(', ')})`);
  }
}

/**
 * A stand-in for `fetch` that serves a sheet's CSV export from its local file, so the bot reads back what it wrote. The first time a sheet is
 * asked for, the file is made from the real export (a plain public download that needs no key), and after that Google is not asked again for it.
 * A request for anything else goes where it was going.
 *
 * `made`: where the bot is not to ask Google at all (the test build), the schedule a sheet with no file yet starts with, made up. Whatever sheet
 * link is typed in, its flights are made-up ones.
 */
export function localSheetFetch(dir: string, realFetch: typeof fetch, log: Logger = silentLogger, made?: (ref: SheetRef) => string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const m = /\/spreadsheets\/d\/([^/]+)\/export\?format=csv(?:&gid=(\d+))?/.exec(String(input));
    if (!m) return realFetch(input, init);
    const ref: SheetRef = { id: m[1] as string, gid: m[2] ?? null };
    const file = localSheetFile(dir, ref);
    if (!existsSync(file)) {
      try {
        const csv = made ? made(ref) : await downloadSheetCsv(ref, realFetch);
        mkdirSync(dir, { recursive: true });
        saveAtomically(file, csv);
        log.info(made ? `Local sheet: made up a schedule for this sheet link (Google is not asked): ${file}. The bot reads and writes this file.` : `Local sheet: made a local copy of the schedule from Google (${csv.split('\n').length} lines): ${file}. From now on the bot reads and writes this file, not Google. Delete it to take a fresh copy.`);
      } catch (e) {
        log.warn(`Local sheet: could not make a local copy of the schedule from Google: ${e instanceof Error ? e.message : String(e)}`);
        return new Response('', { status: 503 });
      }
    }
    return new Response(readFileSync(file, 'utf8'), { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } });
  }) as typeof fetch;
}
