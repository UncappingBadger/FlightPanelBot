import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { TOKEN_URL, type ServiceAccount } from '../src/google/serviceAccount.js';

/** A throwaway service account with a real RSA key, so the bot's token request can be checked for real. */
export function makeServiceAccount(): { account: ServiceAccount; publicKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    account: { email: 'flight-bot@test-project.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    publicKey,
  };
}

export const SHEET_ID = 'Q1w2E3r4T5y6U7i8O9p0AaSsDdFfGgHhJjKkLlZz';
export const TAB_GID = 316683387;
export const TAB_TITLE = "Example Air Sign Up"; // a name with a space, as a real tab would have

/** The columns, in the order a real airline sheet has them. */
export const HEADER = ['Route', 'Date', 'Landing Window Zulu', 'Landing Window US Central', 'Pilot', 'Backup Pilot', 'Aircraft', 'Flight Completed (by Pilot)', 'Pilot Paid'];
export const PILOT_COL = 'E';
export const DONE_COL = 'H';

/** A flight row: route, date, window, then the pilot (blank for none) and whether the box is ticked. */
export const flightRow = (route: string, date: string, pilot = '', done = false, aircraft = 'A320', window = '0600-2359z'): string[] => [
  route,
  date,
  window,
  'x',
  pilot,
  '',
  aircraft,
  done ? 'TRUE' : 'FALSE',
  'FALSE',
];

/**
 * The schedule tab as the tests use it. "Now" is 2026-11-11 12:00Z.
 * Row 1 is the header, so a flight at index i sits on sheet row i + 1.
 */
export function scheduleGrid(): string[][] {
  return [
    HEADER,
    ['Week 2', '11/8/2026', 'Week 2'],
    flightRow('EGLL-EGCC', '11/12/2026'), // row 3: open
    flightRow('EGCC-EGLL', '11/12/2026', 'Taylor'), // row 4: already taken in the sheet
    flightRow('KMIA-KORD', '11/12/2026', '', false, 'B738', '1200-0600z'), // row 5: open, overnight window
    flightRow('EGLL-LFPG', '11/12/2026', 'CANCELLED', true, 'B738'), // row 6: cancelled
    flightRow('EGLL-EGPH', '11/12/2026'), // row 7: open
    flightRow('EGLL-EGKK', '11/13/2026'), // row 8: open
  ];
}

const colIndex = (letters: string) => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

export type GoogleMode = 'ok' | 'view-only' | 'not-shared' | 'down';

/**
 * A pretend Google: the OAuth token endpoint (which really verifies the signed request) and the few
 * Sheets API calls the bot makes, working on an in-memory tab. Nothing here touches the network.
 */
export class FakeGoogle {
  values: string[][] = scheduleGrid();
  mode: GoogleMode = 'ok';
  tokenStatus = 200;
  tokenRequests = 0;
  /** Everything the bot sent, in order. */
  readonly calls: Array<{ method: string; url: string; body: any; auth: string | null }> = [];
  /** Every batchUpdate payload, in order. */
  readonly writes: Array<{ valueInputOption: string; data: Array<{ range: string; values: unknown[][] }> }> = [];
  /** Runs once, just before the next values read answers (to simulate the sheet changing under the bot). */
  beforeNextRead: (() => void) | null = null;

  constructor(private readonly publicKey: KeyObject) {}

  /** What is in a cell right now, e.g. `cell('E3')`. */
  cell(a1: string): string {
    const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
    return this.values[Number(m[2]) - 1]?.[colIndex(m[1] as string)] ?? '';
  }

  readonly fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined;
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    let parsed: any = body;
    if (body && (init?.headers as Record<string, string> | undefined)?.['content-type'] === 'application/json') parsed = JSON.parse(body);
    this.calls.push({ method, url, body: parsed, auth });

    if (url === TOKEN_URL) return this.token(body ?? '');
    return this.sheets(url, method, parsed, auth);
  }) as typeof fetch;

  private json(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }

  private token(body: string): Response {
    this.tokenRequests++;
    if (this.tokenStatus !== 200) return this.json(this.tokenStatus, { error: 'invalid_grant' });
    const params = new URLSearchParams(body);
    const jwt = params.get('assertion') ?? '';
    const [header, claims, signature] = jwt.split('.');
    const valid =
      params.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' &&
      !!header &&
      !!claims &&
      !!signature &&
      createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(this.publicKey, Buffer.from(signature, 'base64url'));
    if (!valid) return this.json(400, { error: 'invalid_grant' });
    return this.json(200, { access_token: `tok-${this.tokenRequests}`, expires_in: 3600, token_type: 'Bearer' });
  }

  private sheets(url: string, method: string, body: any, auth: string | null): Response {
    if (this.mode === 'down') return this.json(503, { error: { message: 'unavailable' } });
    if (!auth?.startsWith('Bearer tok-')) return this.json(401, { error: { message: 'no token' } });
    const base = 'https://sheets.googleapis.com/v4/spreadsheets/';
    if (!url.startsWith(base)) return this.json(404, {});
    const rest = url.slice(base.length);
    const id = rest.split(/[/?]/)[0];
    if (id !== SHEET_ID) return this.json(404, { error: { message: 'not found' } });
    if (this.mode === 'not-shared') return this.json(403, { error: { message: 'The caller does not have permission' } });

    if (method === 'GET' && /^[^/]+\?/.test(rest)) {
      return this.json(200, { sheets: [{ properties: { sheetId: TAB_GID, title: TAB_TITLE } }, { properties: { sheetId: 1, title: 'Pilot Info' } }] });
    }
    if (method === 'GET' && rest.includes('/values/')) {
      const range = decodeURIComponent(rest.split('/values/')[1]!.split('?')[0]!);
      if (range !== `'${TAB_TITLE}'`) return this.json(400, { error: { message: 'Unable to parse range' } });
      this.beforeNextRead?.();
      this.beforeNextRead = null;
      // The real API leaves off empty trailing cells and rows.
      const rows = this.values.map((r) => {
        const out = [...r];
        while (out.length > 0 && out.at(-1) === '') out.pop();
        return out;
      });
      while (rows.length > 0 && rows.at(-1)!.length === 0) rows.pop();
      return this.json(200, { range, majorDimension: 'ROWS', values: rows });
    }
    if (method === 'POST' && rest.endsWith('/values:batchUpdate')) {
      if (this.mode === 'view-only') return this.json(403, { error: { message: 'The caller does not have permission' } });
      this.writes.push(body);
      for (const item of body.data as Array<{ range: string; values: unknown[][] }>) {
        const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)$/.exec(item.range);
        if (!m || m[1]!.replace(/''/g, "'") !== TAB_TITLE) return this.json(400, { error: { message: 'Unable to parse range' } });
        const row = Number(m[3]) - 1;
        const col = colIndex(m[2] as string);
        while (this.values.length <= row) this.values.push([]);
        const cells = this.values[row]!;
        while (cells.length <= col) cells.push('');
        const v = item.values[0]?.[0];
        cells[col] = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v ?? '');
      }
      return this.json(200, { totalUpdatedCells: body.data.length });
    }
    return this.json(404, {});
  }
}
