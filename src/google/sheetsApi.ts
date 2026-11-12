import type { SheetRef } from '../jobs/sheet.js';
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
  /** Text goes in as text (never read as a formula); `true` ticks a checkbox. */
  value: string | boolean;
}

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 20_000;

/** `'My Tab'` with any quote inside doubled, as A1 ranges need. */
const quoteTab = (title: string) => `'${title.replace(/'/g, "''")}'`;

/**
 * The few Google Sheets calls the bot makes: find a tab's name, read it, and write single cells.
 * Everything goes to sheets.googleapis.com; the sheet's ID is checked by the caller, never taken
 * from a person's free text.
 */
export class SheetsApi {
  constructor(
    private readonly token: TokenProvider,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

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
    if (res.ok) return res.json().catch(() => ({}));
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

  /** Every cell of the tab as displayed, row by row. Rows and trailing cells that are empty may be short or missing. */
  async readTab(ref: SheetRef): Promise<{ title: string; values: string[][] }> {
    const title = await this.tabTitle(ref);
    const range = encodeURIComponent(quoteTab(title));
    const data = await this.call('GET', `${BASE}/${ref.id}/values/${range}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
    const rows: unknown[] = Array.isArray(data?.values) ? data.values : [];
    return { title, values: rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) };
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
