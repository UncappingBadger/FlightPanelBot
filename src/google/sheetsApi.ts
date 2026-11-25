import { colLetter, type SheetRef } from '../jobs/sheet.js';
import { readTextCapped } from '../util/http.js';
import { GoogleAuthError, type TokenProvider } from './serviceAccount.js';

export type SheetsErrorCode =
  /** Google would not let the bot sign in. */
  | 'AUTH'
  /** The sheet isn't shared with the bot, or only for viewing. */
  | 'NO_ACCESS'
  /** No such sheet or tab. */
  | 'NOT_FOUND'
  /** Google is down, slow or unreachable. */
  | 'UNAVAILABLE';

/** A failed call to the Google Sheets API. `message` is safe to show to a person. */
export class SheetsError extends Error {
  constructor(
    readonly code: SheetsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SheetsError';
  }
}

export interface Cell {
  /** A1 notation within the tab, such as `E57`. */
  a1: string;
  /** Text goes in as text (never read as a formula); `true` ticks a checkbox; a number goes in as a number (the cell keeps its own format). */
  value: string | boolean | number;
}

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 20_000;

/** `'My Tab'` with any quote inside doubled, as A1 ranges need. */
const quoteTab = (title: string) => `'${title.replace(/'/g, "''")}'`;

/** What the write-back needs from a sheet. Google Sheets is one; the diagnostic build's local file is the other. */
export interface SheetsPort {
  tabTitle(ref: SheetRef): Promise<string>;
  readTab(ref: SheetRef, render?: 'FORMATTED_VALUE' | 'FORMULA'): Promise<{ title: string; values: string[][] }>;
  columnNumberFormats(ref: SheetRef, title: string, col: number, firstRow: number, lastRow: number): Promise<{ sheetId: number; types: Map<number, string> }>;
  setNumberFormat(ref: SheetRef, sheetId: number, col: number, rows: number[], format: { type: string; pattern: string }): Promise<void>;
  update(ref: SheetRef, title: string, cells: Cell[]): Promise<void>;
  /** Forget anything kept about this tab (its name), so the next read asks again. Called when what was read did not match what was expected. */
  forgetTab?(ref: SheetRef): void;
}

/** The most of a reply from Google that is read: a tab bigger than this is refused rather than held in memory and parsed on the bot's only thread. */
const MAX_REPLY_BYTES = 25_000_000;
/** A tab's name is kept this long: it is asked for before every read, and it hardly ever changes. A read that finds it wrong asks again at once. */
const TITLE_KEPT_MS = 5 * 60_000;

/**
 * The few Google Sheets calls the bot makes: find a tab's name, read it, and write single cells.
 * Everything goes to sheets.googleapis.com; the sheet's ID is checked by the caller, never taken
 * from a person's free text.
 */
export class SheetsApi implements SheetsPort {
  /** The name of each tab asked about lately, by sheet and tab: a read is then one request to Google, not two. */
  private readonly titles = new Map<string, { title: string; at: number }>();

  constructor(
    private readonly token: TokenProvider,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private titleKey = (ref: SheetRef): string => `${ref.id}#${ref.gid ?? ''}`;

  forgetTab(ref: SheetRef): void {
    this.titles.delete(this.titleKey(ref));
  }

  private async call(method: 'GET' | 'POST', url: string, body?: unknown): Promise<any> {
    let accessToken: string;
    try {
      accessToken = await this.token();
    } catch (e) {
      if (e instanceof GoogleAuthError) throw new SheetsError('AUTH', e.message);
      throw e;
    }
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SheetsError('UNAVAILABLE', "I couldn't reach Google Sheets just now.");
    }
    if (res.ok) {
      const text = await readTextCapped(res, MAX_REPLY_BYTES).catch(() => null);
      if (text === null) throw new SheetsError('UNAVAILABLE', 'That sheet is too large for me to read.');
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 401) throw new SheetsError('AUTH', 'Google no longer accepts my sign-in.');
    if (res.status === 403) throw new SheetsError('NO_ACCESS', "The sheet isn't shared with me as an editor.");
    if (res.status === 404 || res.status === 400) throw new SheetsError('NOT_FOUND', "Google couldn't find that sheet or tab.");
    throw new SheetsError('UNAVAILABLE', `Google Sheets answered with an error (HTTP ${res.status}).`);
  }

  /** The tab's name. With no `gid` it is the sheet's first tab. */
  async tabTitle(ref: SheetRef): Promise<string> {
    const meta = await this.call('GET', `${BASE}/${ref.id}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`);
    const tabs: Array<{ properties?: { sheetId?: number; title?: string } }> = Array.isArray(meta?.sheets) ? meta.sheets : [];
    const tab = ref.gid === null ? tabs[0] : tabs.find((t) => String(t.properties?.sheetId) === ref.gid);
    const title = tab?.properties?.title;
    if (typeof title !== 'string') throw new SheetsError('NOT_FOUND', "Google couldn't find that tab in the sheet.");
    return title;
  }

  /**
   * Every cell of the tab, row by row: as displayed by default, or (`FORMULA`) as it is stored, which shows the formula of a cell that is
   * computed and the plain content of any other. Rows and trailing cells that are empty may be short or missing.
   */
  async readTab(ref: SheetRef, render: 'FORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE'): Promise<{ title: string; values: string[][] }> {
    const key = this.titleKey(ref);
    const kept = this.titles.get(key);
    const fresh = kept !== undefined && this.now() - kept.at < TITLE_KEPT_MS;
    let title = fresh ? kept.title : await this.tabTitle(ref);
    const read = async () => this.call('GET', `${BASE}/${ref.id}/values/${encodeURIComponent(quoteTab(title))}?majorDimension=ROWS&valueRenderOption=${render}`);
    let data: any;
    try {
      data = await read();
    } catch (e) {
      // A tab's name kept from before may be out of date (it was renamed): ask for it again, once, before giving up.
      if (!(fresh && e instanceof SheetsError && e.code === 'NOT_FOUND')) throw e;
      this.titles.delete(key);
      title = await this.tabTitle(ref);
      data = await read();
    }
    this.titles.set(key, { title, at: this.now() });
    const rows: unknown[] = Array.isArray(data?.values) ? data.values : [];
    return { title, values: rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) };
  }

  /**
   * What the cells of one column, from `firstRow` to `lastRow` (1 is the first row), were told to show a number as: row to format type
   * (`NUMBER`, `DATE`, `CURRENCY`...). A cell that was never given a format is not listed. Also gives the tab's own number.
   */
  async columnNumberFormats(ref: SheetRef, title: string, col: number, firstRow: number, lastRow: number): Promise<{ sheetId: number; types: Map<number, string> }> {
    const range = `${quoteTab(title)}!${colLetter(col)}${firstRow}:${colLetter(col)}${lastRow}`;
    const fields = 'sheets(properties.sheetId,data(startRow,rowData(values(userEnteredFormat.numberFormat))))';
    const data = await this.call('GET', `${BASE}/${ref.id}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`);
    const sheet = Array.isArray(data?.sheets) ? data.sheets[0] : undefined;
    const sheetId = Number(sheet?.properties?.sheetId);
    if (!Number.isSafeInteger(sheetId)) throw new SheetsError('NOT_FOUND', "Google couldn't find that tab in the sheet.");
    const grid = Array.isArray(sheet?.data) ? sheet.data[0] : undefined;
    const start = Number(grid?.startRow ?? 0);
    const rows: unknown[] = Array.isArray(grid?.rowData) ? grid.rowData : [];
    const types = new Map<number, string>();
    rows.forEach((r, i) => {
      const type = (r as { values?: Array<{ userEnteredFormat?: { numberFormat?: { type?: unknown } } }> } | null)?.values?.[0]?.userEnteredFormat?.numberFormat?.type;
      if (typeof type === 'string') types.set(start + i + 1, type);
    });
    return { sheetId, types };
  }

  /** Give these cells of one column a number format and nothing else (their colours, fonts and contents are left as they are). */
  async setNumberFormat(ref: SheetRef, sheetId: number, col: number, rows: number[], format: { type: string; pattern: string }): Promise<void> {
    const runs: Array<[number, number]> = [];
    for (const r of [...new Set(rows)].sort((a, b) => a - b)) {
      const last = runs.at(-1);
      if (last && r === last[1] + 1) last[1] = r;
      else runs.push([r, r]);
    }
    if (runs.length === 0) return;
    await this.call('POST', `${BASE}/${ref.id}:batchUpdate`, {
      requests: runs.map(([first, last]) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: first - 1, endRowIndex: last, startColumnIndex: col, endColumnIndex: col + 1 },
          cell: { userEnteredFormat: { numberFormat: format } },
          fields: 'userEnteredFormat.numberFormat',
        },
      })),
    });
  }

  /** Write cells in one request. Values are stored as given (RAW), so text is never treated as a formula. */
  async update(ref: SheetRef, title: string, cells: Cell[]): Promise<void> {
    if (cells.length === 0) return;
    await this.call('POST', `${BASE}/${ref.id}/values:batchUpdate`, {
      valueInputOption: 'RAW',
      data: cells.map((c) => ({ range: `${quoteTab(title)}!${c.a1}`, values: [[c.value]] })),
    });
  }
}
