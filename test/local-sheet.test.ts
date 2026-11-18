import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LocalSheet, localSheetFetch, localSheetFile } from '../src/google/localSheet.js';
import { SheetsError } from '../src/google/sheetsApi.js';
import { sourceSelector } from '../src/jobs/sheet.js';
import type { AirportCoord } from '../src/db/store.js';
import { AirportDirectory, greatCircleNm } from '../src/services/airports.js';
import { DistanceFiller } from '../src/services/distanceFill.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { SheetWriteBack } from '../src/services/writeback.js';
import type { Logger } from '../src/util/log.js';
import { makeHarness, T0, type Harness } from './helpers.js';
import { settle } from './discord-helpers.js';

/* Everything below is made up: the sheet, its flights and pilots. */

const REF = { id: 'Sheet1d-abc_DEF', gid: '12345' };
const URL_OF = (id: string, gid: string | null) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gid ? `&gid=${gid}` : ''}`;

interface Recorded {
  info: string[];
  warn: string[];
}
const recorder = (): { log: Logger; seen: Recorded } => {
  const seen: Recorded = { info: [], warn: [] };
  const log = { debug: () => undefined, info: (m: string) => void seen.info.push(m), warn: (m: string) => void seen.warn.push(m), error: () => undefined } as unknown as Logger;
  return { log, seen };
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fpb-local-sheet-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ the file */

describe('where a local sheet is kept', () => {
  it('is one file per sheet and tab, named so that nothing in the id can lead out of the folder', () => {
    assert.equal(localSheetFile(dir, REF), join(dir, 'Sheet1d-abc_DEF_12345.csv'));
    assert.equal(localSheetFile(dir, { id: 'abc', gid: null }), join(dir, 'abc_first.csv'));
    const odd = localSheetFile(dir, { id: '../../x/y z', gid: '1' });
    assert.equal(odd, join(dir, '______x_y_z_1.csv'));
    assert.notEqual(localSheetFile(dir, { id: 'abc', gid: '1' }), localSheetFile(dir, { id: 'abc', gid: '2' }));
  });
});

describe('reading and writing a local sheet', () => {
  let sheet: LocalSheet;
  let seen: Recorded;
  const file = () => localSheetFile(dir, REF);
  const csv = (text: string) => writeFileSync(file(), text);
  beforeEach(() => {
    const r = recorder();
    seen = r.seen;
    sheet = new LocalSheet(dir, r.log);
  });

  it('reads a tab as the Sheets API gives it: every cell as text, empty trailing cells and rows left off', async () => {
    csv('Route,Date,Pilot\r\nEGLL-EGKK,11/12/2026,Alex\r\n,,\r\n\r\nEGKK-EGLL,11/12/2026,\r\n,,\r\n');
    assert.deepEqual(await sheet.readTab(REF), { title: 'Local sheet', values: [['Route', 'Date', 'Pilot'], ['EGLL-EGKK', '11/12/2026', 'Alex'], [], [], ['EGKK-EGLL', '11/12/2026']] });
    assert.equal(await sheet.tabTitle(REF), 'Local sheet');
  });

  it('reads a quoted cell with a comma, a quote or a line break in it, and does the same for the stored view', async () => {
    csv('A,B\n"one, two","say ""hi""\nthere"\n');
    const want = [['A', 'B'], ['one, two', 'say "hi"\nthere']];
    assert.deepEqual((await sheet.readTab(REF)).values, want);
    assert.deepEqual((await sheet.readTab(REF, 'FORMULA')).values, want, 'a file has no formulas, so the stored view is the same');
  });

  it('says there is no local copy when there is none, in the words the bot already handles', async () => {
    await assert.rejects(sheet.readTab(REF), (e: unknown) => e instanceof SheetsError && e.code === 'NOT_FOUND');
    await assert.rejects(sheet.update(REF, 'x', [{ a1: 'A1', value: 1 }]), (e: unknown) => e instanceof SheetsError && e.code === 'NOT_FOUND');
  });

  it('writes a number as a number, a box as TRUE or FALSE, and text as text, growing the sheet where it has to', async () => {
    csv('Route,Distance\nEGLL-EGKK,\n');
    await sheet.update(REF, 'Local sheet', [{ a1: 'B2', value: 25 }, { a1: 'C2', value: true }, { a1: 'D2', value: false }, { a1: 'A4', value: 'Alex' }, { a1: 'AA1', value: 'far' }]);
    const { values } = await sheet.readTab(REF);
    assert.deepEqual(values[1], ['EGLL-EGKK', '25', 'TRUE', 'FALSE']);
    assert.deepEqual(values[3], ['Alex']);
    assert.equal(values[0]![26], 'far');
    assert.deepEqual(values[2], [], 'a row in between is empty, not missing');
  });

  it('keeps a value that needs quoting intact, and every other cell as it was', async () => {
    csv('A,B,C\n1,2,3\n');
    await sheet.update(REF, 'x', [{ a1: 'B2', value: 'a, "b"\nc' }]);
    assert.equal(readFileSync(file(), 'utf8'), 'A,B,C\r\n1,"a, ""b""\nc",3\r\n');
    assert.deepEqual((await sheet.readTab(REF)).values, [['A', 'B', 'C'], ['1', 'a, "b"\nc', '3']]);
  });

  it('writes the whole file in one go and leaves no half-written file behind', async () => {
    csv('A,B\n1,2\n');
    await sheet.update(REF, 'x', [{ a1: 'A2', value: 9 }]);
    assert.deepEqual(readdirSync(dir), ['Sheet1d-abc_DEF_12345.csv']);
  });

  it('does nothing, and says nothing, for no cells, and refuses what is not a cell', async () => {
    csv('A\n1\n');
    await sheet.update(REF, 'x', []);
    assert.deepEqual(seen.info, []);
    await assert.rejects(sheet.update(REF, 'x', [{ a1: 'nonsense', value: 1 }]), (e: unknown) => e instanceof SheetsError);
    assert.equal(readFileSync(file(), 'utf8'), 'A\n1\n', 'unchanged');
  });

  it('says in the log what it wrote, cell by cell', async () => {
    csv('A,B\n1,\n');
    await sheet.update(REF, 'x', [{ a1: 'B2', value: 427 }, { a1: 'C2', value: true }]);
    assert.deepEqual(seen.info, ['Local sheet: wrote B2=427, C2=true']);
  });
});

describe('the number formats of a local sheet', () => {
  let sheet: LocalSheet;
  const sidecar = () => `${localSheetFile(dir, REF)}.formats.json`;
  beforeEach(() => {
    sheet = new LocalSheet(dir, recorder().log);
    writeFileSync(localSheetFile(dir, REF), 'A,B\n1,\n');
  });

  it('has none until a file says so, which is how a cell that was never given a format looks', async () => {
    assert.deepEqual(await sheet.columnNumberFormats(REF, 'x', 1, 2, 6), { sheetId: 0, types: new Map() });
  });

  it('reads the formats a person wrote into the file beside it, for just the cells asked about', async () => {
    writeFileSync(sidecar(), JSON.stringify({ B3: { type: 'DATE', pattern: 'M/d/yyyy' }, B9: { type: 'CURRENCY' }, C3: { type: 'PERCENT' }, B4: {} }));
    const { types } = await sheet.columnNumberFormats(REF, 'x', 1, 2, 6);
    assert.deepEqual([...types], [[3, 'DATE']]);
  });

  it('keeps the formats it is asked to set, beside the ones already there, and says so', async () => {
    const r = recorder();
    const noisy = new LocalSheet(dir, r.log);
    writeFileSync(sidecar(), JSON.stringify({ C1: { type: 'TEXT' } }));
    await noisy.setNumberFormat(REF, 0, 1, [3, 4, 7], { type: 'NUMBER', pattern: '#,##0' });
    assert.deepEqual(JSON.parse(readFileSync(sidecar(), 'utf8')), { C1: { type: 'TEXT' }, B3: { type: 'NUMBER', pattern: '#,##0' }, B4: { type: 'NUMBER', pattern: '#,##0' }, B7: { type: 'NUMBER', pattern: '#,##0' } });
    assert.match(r.seen.info[0]!, /gave 3 cells of column B the number format NUMBER #,##0 \(rows 3, 4, 7\)/);
    assert.deepEqual([...(await noisy.columnNumberFormats(REF, 'x', 1, 1, 8)).types], [[3, 'NUMBER'], [4, 'NUMBER'], [7, 'NUMBER']]);
  });

  it('is not thrown by a formats file that is damaged, or is not a map', async () => {
    for (const junk of ['not json', '[1,2]', 'null', '']) {
      writeFileSync(sidecar(), junk);
      assert.deepEqual([...(await sheet.columnNumberFormats(REF, 'x', 1, 1, 9)).types], [], junk);
    }
    writeFileSync(sidecar(), 'not json');
    await sheet.setNumberFormat(REF, 0, 1, [2], { type: 'NUMBER', pattern: '0' });
    assert.deepEqual(JSON.parse(readFileSync(sidecar(), 'utf8')), { B2: { type: 'NUMBER', pattern: '0' } });
  });
});

/* ------------------------------------------------------------------ standing in for Google's CSV export */

describe('serving the schedule from the local file', () => {
  const CSV = 'Route,Date\nEGLL-EGKK,11/12/2026\n';
  let asked: string[];
  let reply: () => Response;
  let seen: Recorded;
  let local: typeof fetch;
  beforeEach(() => {
    asked = [];
    reply = () => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } });
    const r = recorder();
    seen = r.seen;
    local = localSheetFetch(dir, (async (input: unknown) => (asked.push(String(input)), reply())) as typeof fetch, r.log);
  });

  it('makes the local copy from the real export the first time, and never asks Google for that sheet again', async () => {
    const first = await local(URL_OF(REF.id, REF.gid));
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') ?? '', /text\/csv/);
    assert.equal(await first.text(), CSV);
    assert.equal(existsSync(localSheetFile(dir, REF)), true);
    assert.equal(asked.length, 1);
    const second = await local(URL_OF(REF.id, REF.gid));
    assert.equal(await second.text(), CSV);
    assert.equal(asked.length, 1, 'no second request to Google');
    assert.match(seen.info[0]!, /made a local copy of the schedule from Google/);
    assert.match(seen.info[0]!, /reads and writes this file, not Google/);
  });

  it('serves what was written into the file since, not what Google has', async () => {
    await local(URL_OF(REF.id, REF.gid));
    await new LocalSheet(dir).update(REF, 'x', [{ a1: 'C1', value: 'Distance' }, { a1: 'C2', value: 24 }]);
    assert.equal(await (await local(URL_OF(REF.id, REF.gid))).text(), 'Route,Date,Distance\r\nEGLL-EGKK,11/12/2026,24\r\n');
    assert.equal(asked.length, 1);
  });

  it('keeps a file for each tab, and one for a sheet whose link names no tab', async () => {
    await local(URL_OF(REF.id, '1'));
    await local(URL_OF(REF.id, '2'));
    await local(URL_OF(REF.id, null));
    assert.equal(asked.length, 3);
    assert.deepEqual(readdirSync(dir).sort(), [`${REF.id}_1.csv`, `${REF.id}_2.csv`, `${REF.id}_first.csv`].sort());
  });

  it('sends anything that is not a sheet export where it was going', async () => {
    reply = () => new Response('hello', { status: 200 });
    const res = await local('https://example.com/other');
    assert.equal(await res.text(), 'hello');
    assert.deepEqual(asked, ['https://example.com/other']);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('answers with an error, and says why, when the first copy cannot be made, and tries again next time', async () => {
    reply = () => new Response('', { status: 403 });
    const res = await local(URL_OF(REF.id, REF.gid));
    assert.equal(res.status, 503);
    assert.equal(existsSync(localSheetFile(dir, REF)), false, 'no half a file');
    assert.match(seen.warn[0]!, /could not make a local copy of the schedule from Google/);
    reply = () => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } });
    assert.equal((await local(URL_OF(REF.id, REF.gid))).status, 200);
  });

  it('makes the folder if it is not there yet', async () => {
    const deeper = join(dir, 'a', 'b');
    const f = localSheetFetch(deeper, (async () => new Response(CSV, { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch);
    assert.equal((await f(URL_OF(REF.id, REF.gid))).status, 200);
    assert.equal(existsSync(join(deeper, `${REF.id}_${REF.gid}.csv`)), true);
  });
});

/* ------------------------------------------------------------------ the whole loop, with nothing going to Google */

const POS: Record<string, AirportCoord> = {
  EGLL: { lat: 51.4706, lon: -0.4619, name: 'London Heathrow' },
  EGKK: { lat: 51.1481, lon: -0.1903, name: 'London Gatwick' },
  KJFK: { lat: 40.6398, lon: -73.7789, name: 'New York JFK' },
  KBOS: { lat: 42.3643, lon: -71.0052, name: 'Boston' },
};

describe('the diagnostic build\'s loop: read the local copy, fill in the distances, read them back', () => {
  let h: Harness;
  let googleCalls: string[];
  let downloads: number;
  let refresher: SourceRefresher;
  let wb: SheetWriteBack;
  let seen: Recorded;
  const SHEET = [
    'Route,Distance (NM),Date,Landing Window Zulu,Pilot,Backup Pilot,Aircraft,Flight Completed (by Pilot),Pilot Paid',
    'EGLL-EGKK,,11/12/2026,0600-2359z,,,A320,FALSE,FALSE', // row 2
    'EGLL-KJFK,,11/12/2026,0600-2359z,,,A320,FALSE,FALSE', // row 3
    'KJFK-KBOS,,11/12/2026,0600-2359z,,,A320,FALSE,FALSE', // row 4
    'KBOS-EGLL,500,11/12/2026,0600-2359z,,,A320,FALSE,FALSE', // row 5: a distance somebody typed
  ].join('\n');
  const LIST = ['id,ident,type,name,latitude_deg,longitude_deg,gps_code,icao_code', ...Object.entries(POS).map(([code, p], i) => `${i + 1},${code},large_airport,${p.name},${p.lat},${p.lon},${code},${code}`)].join('\n');
  const localFile = () => readFileSync(localSheetFile(dir, { id: h.store.getPanel(h.panel.id)!.sheetId!, gid: '77' }), 'utf8');
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    googleCalls = [];
    downloads = 0;
    const r = recorder();
    seen = r.seen;
    h.store.updatePanel(h.panel.id, { sheetId: 'LocalLoop123', sheetGid: '77', writeback: true });
    const googleFetch = (async (input: unknown) => (googleCalls.push(String(input)), new Response(SHEET, { status: 200, headers: { 'content-type': 'text/csv' } }))) as typeof fetch;
    wb = new SheetWriteBack(new LocalSheet(dir, r.log), 'the local debug sheet', { now: () => h.clock.now, logger: r.log });
    const directory = new AirportDirectory(h.store, { fetchFn: async () => (downloads++, new Response(LIST)), now: () => h.clock.now });
    const filler = new DistanceFiller({ writeback: wb, airports: directory, positions: (codes) => h.store.getAirportCoords(codes), logger: r.log });
    refresher = new SourceRefresher(h.store, h.jobs, sourceSelector({ fetchFn: localSheetFetch(dir, googleFetch, r.log) }), undefined, () => h.clock.now, (p, list, fetched) => filler.enrich(p, list, fetched), undefined, (p, fetched) => filler.run(p, fetched));
  });
  afterEach(async () => {
    await h.close();
  });

  it('takes one copy from Google, fills in the blank distances into the local file, and leaves the one somebody typed', async () => {
    await refresher.refresh(panel());
    await settle(60);
    assert.equal(googleCalls.length, 1, 'Google was asked once, for the copy');
    const rows = localFile().trim().split('\r\n');
    assert.equal(rows[0], 'Route,Distance (NM),Date,Landing Window Zulu,Pilot,Backup Pilot,Aircraft,Flight Completed (by Pilot),Pilot Paid');
    assert.equal(rows[1]!.split(',')[1], String(Math.round(gcOf('EGLL', 'EGKK'))));
    assert.equal(rows[2]!.split(',')[1], String(Math.round(gcOf('EGLL', 'KJFK'))));
    assert.equal(rows[3]!.split(',')[1], String(Math.round(gcOf('KJFK', 'KBOS'))));
    assert.equal(rows[4]!.split(',')[1], '500', 'the typed one is untouched');
    assert.equal(downloads, 1, 'the airport list was read once');
    assert.match(seen.info.join('\n'), /Local sheet: wrote B2=\d+, B3=\d+, B4=\d+/);
  });

  it('reads the distances back on the next read, shows them on the flights, and has nothing more to write', async () => {
    await refresher.refresh(panel());
    await settle(60);
    seen.info.length = 0;
    await refresher.refresh(panel());
    await settle(60);
    const byKey = new Map(h.store.listJobs(h.panel.id).map((j) => [j.sourceKey, j]));
    assert.equal(byKey.get('EGLL-KJFK@2026-11-12')!.distanceNm, Math.round(gcOf('EGLL', 'KJFK')));
    assert.equal(byKey.get('KBOS-EGLL@2026-11-12')!.distanceNm, 500);
    assert.deepEqual(seen.info.filter((m) => m.startsWith('Local sheet: wrote')), [], 'nothing left to write');
    assert.equal(googleCalls.length, 1);
  });

  it('never calls Google for a write, and keeps pilots\' names and ticks in the local file too', async () => {
    await refresher.refresh(panel());
    await settle(60);
    const key = 'EGLL-KJFK@2026-11-12';
    await wb.claim(panel(), key, 'Alex');
    await wb.complete(panel(), key, 'Alex');
    const row = localFile().trim().split('\r\n')[2]!.split(',');
    assert.deepEqual([row[4], row[7]], ['Alex', 'TRUE']);
    assert.ok(googleCalls.every((u) => u.includes('/export?format=csv')), 'only the one plain download, ever');
  });

  it('gives a cell the local formats file says would show a date a plain number format, as the real sheet would be treated', async () => {
    await refresher.refresh(panel());
    await settle(60);
    // Take a fresh copy and say that B2 is formatted as a date, then let the bot fill it in.
    const file = localSheetFile(dir, { id: 'LocalLoop123', gid: '77' });
    writeFileSync(file, SHEET);
    writeFileSync(`${file}.formats.json`, JSON.stringify({ B2: { type: 'DATE', pattern: 'M/d/yyyy' } }));
    await refresher.refresh(panel());
    await settle(60);
    assert.deepEqual(JSON.parse(readFileSync(`${file}.formats.json`, 'utf8')).B2, { type: 'NUMBER', pattern: '#,##0' });
    assert.match(seen.info.join('\n'), /gave 1 cell of column B the number format NUMBER #,##0 \(rows 2\)/);
  });
});

function gcOf(a: string, b: string): number {
  return greatCircleNm(POS[a]!, POS[b]!);
}
