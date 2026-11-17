import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AirportCoord } from '../src/db/store.js';
import { parseScheduleValues, parseSheetCsv } from '../src/jobs/sheet.js';
import type { FetchedJobs, JobSource } from '../src/jobs/types.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { greatCircleNm } from '../src/services/airports.js';
import { DistanceFiller } from '../src/services/distanceFill.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import { makeHarness, T0, type Harness } from './helpers.js';
import { settle } from './discord-helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up: the airline's sheet, its flights, pilots and aircraft. */

const { account, publicKey } = makeServiceAccount();

/** The columns of an airline's schedule sheet with a Distance column and a Daily Flight Sequence column added. */
const HEADER = ['Route', 'Distance (NM)', 'Date', 'Landing Window Zulu', 'Landing Window US Central', 'Pilot', 'Backup Pilot', 'Daily Flight Sequence', 'Aircraft', 'Flight Completed (by Pilot)', 'Pilot Paid', 'Profit Made', 'Pilot Pay'];
interface RowOpts {
  distance?: string;
  pilot?: string;
  backup?: string;
  seq?: string;
  done?: boolean;
}
const row = (route: string, date: string, o: RowOpts = {}): string[] => [route, o.distance ?? '', date, '0600-2359z', 'Thu 0000 - Thu 1759 CT', o.pilot ?? '', o.backup ?? '', o.seq ?? '', 'A320', o.done ? 'TRUE' : 'FALSE', 'FALSE', '', ''];
const csvOf = (grid: string[][]) => grid.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

const KEYS = { a: 'EGLL-EGKK@2026-11-12', b: 'EGKK-EGLL@2026-11-12', c: 'EGLL-EGCC@2026-11-12', d: 'EGCC-EGLL@2026-11-13', e: 'EGLL-EGPH@2026-11-13' };
const grid = (): string[][] => [
  HEADER,
  ['Week 2', '', 'Week 2'],
  row('EGLL-EGKK', '11/12/2026', { seq: '1' }), // row 3: blank distance, first of a sequence
  row('EGKK-EGLL', '11/12/2026', { seq: '2', backup: 'Sam' }), // row 4: blank, second of a sequence, with a backup
  row('EGLL-EGCC', '11/12/2026', { distance: '152' }), // row 5: filled in
  row('EGCC-EGLL', '11/13/2026', { distance: ' ' }), // row 6: a stray space is something
  row('EGLL-EGPH', '11/13/2026', { pilot: 'CANCELLED' }), // row 7: cancelled
];

/* ------------------------------------------------------------------ reading the two columns */

describe('reading the Distance and Daily Flight Sequence columns', () => {
  const read = (g = grid()) => parseSheetCsv(csvOf(g), T0);
  const byKey = (f: FetchedJobs) => new Map(f.jobs.map((j) => [j.key, j]));

  it('still reads every other column where it is, with the two new ones between them', () => {
    const jobs = byKey(read());
    const a = jobs.get(KEYS.a)!;
    assert.deepEqual([a.legs.map((l) => `${l.dep}-${l.arr}`), a.aircraft, a.closed], [['EGLL-EGKK'], 'A320', false]);
    assert.equal(jobs.get(KEYS.e)!.closed, true, 'a cancelled flight is still closed');
    assert.deepEqual(parseScheduleValues(grid(), T0)!.cols, { pilot: 5, done: 9, profit: 11, pay: 12, distance: 1 });
  });

  it('lists the flights whose Distance cell has nothing in it, and only those', () => {
    assert.deepEqual(read().blankDistances, [KEYS.a, KEYS.b]);
  });

  it('does not list a cell with a number, a zero, a note or a space, or a cancelled flight', () => {
    const g = grid();
    g[2]![1] = '0';
    g[3]![1] = 'TBD';
    assert.deepEqual(read(g).blankDistances, []);
  });

  it('knows nothing of distances when the sheet has no such column', () => {
    const g = grid().map((r) => r.filter((_, i) => i !== 1));
    const r = read(g);
    assert.equal(r.blankDistances, undefined);
    assert.equal(r.jobs.length, 5);
    assert.equal(parseScheduleValues(g, T0)!.cols.distance, -1);
  });

  it('takes the other names such a column goes by', () => {
    for (const name of ['Distance', 'Distance NM', 'distance (nm)', 'Distance (NMI)']) {
      const g = grid();
      g[0] = g[0]!.map((c) => (c === 'Distance (NM)' ? name : c));
      assert.deepEqual(read(g).blankDistances, [KEYS.a, KEYS.b], name);
    }
  });

  it('keeps only flights it has kept in the list when the sheet has more than the bot shows', () => {
    const letter = (n: number) => String.fromCharCode(65 + n);
    const many = [HEADER, ...Array.from({ length: 1005 }, (_, i) => row(`EGLL-E${letter(Math.floor(i / 676))}${letter(Math.floor(i / 26) % 26)}${letter(i % 26)}`, '11/12/2026'))];
    const r = read(many);
    assert.equal(r.jobs.length, 1000);
    assert.equal(r.blankDistances!.length, 1000, 'no key for a flight that was dropped');
    assert.ok(r.blankDistances!.every((k) => r.jobs.some((j) => j.key === k)));
  });

  it('shows a flight\'s place in a sequence with the flight, beside the backup when there is one', () => {
    const jobs = byKey(read());
    assert.equal(jobs.get(KEYS.a)!.notes, 'Flight sequence: 1');
    assert.equal(jobs.get(KEYS.b)!.notes, 'Flight sequence: 2 · Backup: Sam');
    assert.equal(jobs.get(KEYS.c)!.notes, null, 'no sequence, no backup, no note');
  });

  it('shows a backup alone as before, and takes a sequence written as a run of numbers', () => {
    const g = grid();
    g[2]![7] = '';
    g[2]![6] = 'Pat';
    g[3]![7] = '1-2-3-4';
    const jobs = byKey(read(g));
    assert.equal(jobs.get(KEYS.a)!.notes, 'Backup: Pat');
    assert.equal(jobs.get(KEYS.b)!.notes, 'Flight sequence: 1-2-3-4 · Backup: Sam');
  });

  it('cuts a sequence cell that is far too long, and tidies it, so it cannot fill a card', () => {
    const g = grid();
    g[2]![7] = '1 '.repeat(40);
    const note = byKey(read(g)).get(KEYS.a)!.notes!;
    assert.ok(note.length <= 'Flight sequence: '.length + 20, note);
    assert.match(note, /^Flight sequence: 1 1/);
  });

  it('takes the other names the sequence column goes by', () => {
    for (const name of ['Flight Sequence', 'Sequence', 'Daily Sequence']) {
      const g = grid();
      g[0] = g[0]!.map((c) => (c === 'Daily Flight Sequence' ? name : c));
      assert.equal(byKey(read(g)).get(KEYS.a)!.notes, 'Flight sequence: 1', name);
    }
  });
});

/* ------------------------------------------------------------------ writing the distances */

describe('writing distances into the sheet', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = grid();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes each distance into the blank Distance cell of its own row, as a number, in one request, and touches nothing else', async () => {
    const before = g.values.map((r) => [...r]);
    const got = await wb.fillDistances(panel(), [{ sourceKey: KEYS.a, nm: 25 }, { sourceKey: KEYS.b, nm: 25 }]);
    assert.equal(got.written, 2);
    assert.equal(g.writes.length, 1);
    assert.equal(g.writes[0]!.valueInputOption, 'RAW');
    assert.deepEqual(g.writes[0]!.data.map((d) => [d.range.split('!')[1], d.values[0]![0]]), [['B3', 25], ['B4', 25]]);
    assert.ok(g.writes[0]!.data.every((d) => typeof d.values[0]![0] === 'number'), 'numbers, not text');
    for (let r = 0; r < before.length; r++) for (let c = 0; c < before[r]!.length; c++) if (!(c === 1 && (r === 2 || r === 3))) assert.equal(g.values[r]![c] ?? '', before[r]![c] ?? '', `row ${r + 1} column ${c}`);
  });

  it('never replaces a Distance cell that has anything in it: a number, a zero, a note, a stray space, or a formula', async () => {
    const attempt = async (setup: () => void) => {
      g.values = grid();
      g.formulas.clear();
      g.writes.length = 0;
      setup();
      return wb.fillDistances(panel(), [{ sourceKey: KEYS.a, nm: 25 }]);
    };
    for (const [what, setup] of [
      ['a number', () => void (g.values[2]![1] = '30')],
      ['a zero', () => void (g.values[2]![1] = '0')],
      ['a note', () => void (g.values[2]![1] = 'TBD')],
      ['a stray space', () => void (g.values[2]![1] = ' ')],
      ['an error', () => void (g.values[2]![1] = '#N/A')],
      ['a formula that shows nothing', () => void g.formulas.set('B3', '=IF(1=2,1,"")')],
      ['a formula with a value', () => void ((g.values[2]![1] = '40'), g.formulas.set('B3', '=D3*2'))],
    ] as Array<[string, () => void]>) {
      const got = await attempt(setup);
      assert.equal(got.written, 0, what);
      assert.equal(g.writes.length, 0, `${what}: not even a request`);
      assert.notEqual(g.cell('B3'), '25', what);
    }
    assert.equal((await attempt(() => undefined)).written, 1, 'a truly empty cell still is filled');
  });

  it('finds a flight again by its key when the rows have moved, and skips one that is gone', async () => {
    g.values.splice(2, 0, row('EGLL-EGPH', '11/14/2026')); // a row inserted above: every row below moves down
    const got = await wb.fillDistances(panel(), [{ sourceKey: KEYS.a, nm: 25 }, { sourceKey: 'EGXX-EGYY@2026-11-12', nm: 99 }]);
    assert.equal(got.written, 1);
    assert.equal(g.writes[0]!.data[0]!.range.split('!')[1], 'B4', 'the row it is on now');
    assert.equal(g.cell('B3'), '', 'not the row it used to be on');
  });

  it('writes only what is still blank when it looks, so a manager who typed one meanwhile is not overwritten', async () => {
    g.beforeNextRead = () => {
      g.values[2]![1] = '27';
    };
    const got = await wb.fillDistances(panel(), [{ sourceKey: KEYS.a, nm: 25 }, { sourceKey: KEYS.b, nm: 25 }]);
    assert.equal(got.written, 1);
    assert.equal(g.cell('B3'), '27');
    assert.equal(g.cell('B4'), '25');
  });

  it('asks nothing of Google when there is nothing to write, and writes nothing to a tab with no Distance column', async () => {
    assert.deepEqual(await wb.fillDistances(panel(), []), { written: 0 });
    assert.equal(g.calls.length, 0);
    g.values = grid().map((r) => r.filter((_, i) => i !== 1));
    assert.deepEqual(await wb.fillDistances(panel(), [{ sourceKey: KEYS.a, nm: 25 }]), { written: 0 });
    assert.equal(g.writes.length, 0);
  });

  it('says so when Google refuses or there is no sheet', async () => {
    g.mode = 'view-only';
    await assert.rejects(wb.fillDistances(panel(), [{ sourceKey: KEYS.a, nm: 25 }]), (e: unknown) => e instanceof WriteBackError && e.code === 'GOOGLE');
    h.store.updatePanel(h.panel.id, { sheetId: null, sheetGid: null });
    await assert.rejects(wb.fillDistances(panel(), [{ sourceKey: KEYS.a, nm: 25 }]), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_SHEET');
  });
});

/* ------------------------------------------------------------------ working the distances out */

const POS: Record<string, AirportCoord> = {
  EGLL: { lat: 51.4706, lon: -0.4619, name: 'London Heathrow' },
  EGKK: { lat: 51.1481, lon: -0.1903, name: 'London Gatwick' },
  EGCC: { lat: 53.3537, lon: -2.275, name: 'Manchester' },
  KJFK: { lat: 40.6398, lon: -73.7789, name: 'New York JFK' },
  KBOS: { lat: 42.3643, lon: -71.0052, name: 'Boston' },
};
const nm = (a: string, b: string) => Math.round(greatCircleNm(POS[a]!, POS[b]!));

describe('working out the distance of a flight', () => {
  let h: Harness;
  let asked: string[][];
  let written: Array<Array<{ sourceKey: string; nm: number }>>;
  let enabled: boolean;
  let fail: Error | null;
  let filler: DistanceFiller;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const job = (key: string, legs: Array<[string, string]>) => ({ key, title: null, legs: legs.map(([dep, arr]) => ({ dep, arr })), aircraft: null, availableFrom: null, deadline: null, pay: null, notes: null });
  const fetched = (jobs: ReturnType<typeof job>[], blankDistances: string[] | undefined): FetchedJobs => ({ jobs, warnings: [], ...(blankDistances ? { blankDistances } : {}) });

  beforeEach(async () => {
    h = await makeHarness();
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
    asked = [];
    written = [];
    enabled = true;
    fail = null;
    filler = new DistanceFiller({
      writeback: {
        enabledFor: () => enabled,
        fillDistances: async (_p, plan) => {
          if (fail) throw fail;
          written.push(plan);
          return { written: plan.length };
        },
      },
      airports: {
        coords: async (codes: string[]) => {
          asked.push(codes);
          const tidy = codes.map((c) => c.trim().toUpperCase());
          return new Map(tidy.filter((c) => POS[c]).map((c) => [c, POS[c]!]));
        },
      },
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('is the great-circle distance between the two airports, in whole nautical miles', async () => {
    const n = await filler.run(panel(), fetched([job('k1', [['EGLL', 'KJFK']])], ['k1']));
    assert.equal(n, 1);
    assert.deepEqual(written, [[{ sourceKey: 'k1', nm: nm('EGLL', 'KJFK') }]]);
    assert.ok(written[0]![0]!.nm > 2900 && written[0]![0]!.nm < 3100, `${written[0]![0]!.nm} nm`);
    assert.equal(Number.isInteger(written[0]![0]!.nm), true);
  });

  it('adds the legs up for a flight of several', async () => {
    await filler.run(panel(), fetched([job('k1', [['EGLL', 'KJFK'], ['KJFK', 'KBOS']])], ['k1']));
    assert.equal(written[0]![0]!.nm, Math.round(greatCircleNm(POS.EGLL!, POS.KJFK!) + greatCircleNm(POS.KJFK!, POS.KBOS!)));
  });

  it('works out only the flights whose cell is blank, and asks about only their airports', async () => {
    await filler.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']]), job('k2', [['EGCC', 'KJFK']]), job('k3', [['EGLL', 'KBOS']])], ['k1', 'k3']));
    assert.deepEqual(written[0]!.map((p) => p.sourceKey), ['k1', 'k3']);
    assert.deepEqual(asked, [['EGLL', 'EGKK', 'EGLL', 'KBOS']]);
  });

  it('leaves a flight alone whose airports it has no position for, and still does the others', async () => {
    await filler.run(panel(), fetched([job('k1', [['EGLL', 'ZZZZ']]), job('k2', [['EGLL', 'EGKK']]), job('k3', [['EGLL', 'EGKK'], ['EGKK', 'ZZZZ']])], ['k1', 'k2', 'k3']));
    assert.deepEqual(written[0]!.map((p) => p.sourceKey), ['k2']);
  });

  it('takes the airport codes in any case', async () => {
    await filler.run(panel(), fetched([job('k1', [['egll', ' EGKK ']])], ['k1']));
    assert.equal(written[0]![0]!.nm, nm('EGLL', 'EGKK'));
  });

  it('writes nothing for a flight from an airport to itself', async () => {
    await filler.run(panel(), fetched([job('k1', [['EGLL', 'EGLL']])], ['k1']));
    assert.deepEqual(written, []);
  });

  it('does nothing, and asks for nothing, when no cell is blank, the sheet has no such column, or writing is off', async () => {
    assert.equal(await filler.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']])], [])), 0);
    assert.equal(await filler.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']])], undefined)), 0);
    enabled = false;
    assert.equal(await filler.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']])], ['k1'])), 0);
    h.store.updatePanel(h.panel.id, { sheetId: null, sheetGid: null });
    enabled = true;
    assert.equal(await filler.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']])], ['k1'])), 0);
    assert.deepEqual([asked, written], [[], []]);
  });

  it('does nothing without Google credentials', async () => {
    const none = new DistanceFiller({ writeback: null, airports: { coords: async () => new Map() } });
    assert.equal(await none.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']])], ['k1'])), 0);
  });

  it('never throws: a sheet that will not take the write, or an airport list that cannot be read, only means nothing is filled in', async () => {
    fail = new WriteBackError('GOOGLE', 'no');
    assert.equal(await filler.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']])], ['k1'])), 0);
    fail = null;
    const broken = new DistanceFiller({ writeback: { enabledFor: () => true, fillDistances: async () => ({ written: 1 }) }, airports: { coords: async () => Promise.reject(new Error('down')) } });
    assert.equal(await broken.run(panel(), fetched([job('k1', [['EGLL', 'EGKK']])], ['k1'])), 0);
  });

  it('does not start a second fill of a panel while one is still going, and can fill it again after', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = new DistanceFiller({
      writeback: { enabledFor: () => true, fillDistances: async (_p, plan) => ({ written: plan.length }) },
      airports: {
        coords: async (codes: string[]) => {
          calls++;
          if (calls === 1) await gate;
          return new Map(codes.map((c) => [c, POS[c]!]));
        },
      },
    });
    const flight = () => fetched([job('k1', [['EGLL', 'EGKK']])], ['k1']);
    const first = slow.run(panel(), flight());
    assert.equal(await slow.run(panel(), flight()), 0, 'the second one stands aside');
    assert.equal(calls, 1, 'and does not ask for the airports again');
    release();
    assert.equal(await first, 1);
    assert.equal(await slow.run(panel(), flight()), 1, 'once it is done, the panel can be filled again');
  });
});

/* ------------------------------------------------------------------ reading the schedule fills them in */

describe('reading the schedule fills in the distances', () => {
  let h: Harness;
  let g: FakeGoogle;
  let filler: DistanceFiller;
  let refresher: SourceRefresher;
  let hookCalls: number;
  let hookFails: boolean;
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = grid();
    const wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID), writeback: true });
    filler = new DistanceFiller({ writeback: wb, airports: { coords: async (codes: string[]) => new Map(codes.filter((c) => POS[c]).map((c) => [c, POS[c]!])) } });
    hookCalls = 0;
    hookFails = false;
    const source: JobSource = { kind: 'google-sheet', fetch: async () => parseSheetCsv(csvOf(g.values), h.clock.now) };
    refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, () => h.clock.now, null, undefined, async (p, f) => {
      hookCalls++;
      if (hookFails) throw new Error('the hook broke');
      await filler.run(p, f);
    });
  });
  afterEach(async () => {
    await h.close();
  });

  it('fills the blank Distance cells of the flights it has just read, and leaves the others as they are', async () => {
    await refresher.refresh(panel());
    await settle(40);
    assert.equal(g.cell('B3'), String(nm('EGLL', 'EGKK')));
    assert.equal(g.cell('B4'), String(nm('EGKK', 'EGLL')));
    assert.equal(g.cell('B5'), '152', 'a typed distance is kept');
    assert.equal(g.cell('B6'), ' ', 'a stray space is kept');
    assert.equal(g.cell('B7'), '', 'a cancelled flight is not filled in');
    assert.equal(g.writes.length, 1);
  });

  it('has nothing to write the next time, because the distances are there now', async () => {
    await refresher.refresh(panel());
    await settle(40);
    g.writes.length = 0;
    g.calls.length = 0;
    await refresher.refresh(panel());
    await settle(40);
    assert.equal(g.writes.length, 0);
    assert.equal(g.calls.length, 0, 'not even a read: the schedule said no cell was blank');
  });

  it('shows the sequence on the flights it applies', async () => {
    await refresher.refresh(panel());
    const notes = h.store.listJobs(h.panel.id).map((j) => j.notes);
    assert.ok(notes.includes('Flight sequence: 1'));
    assert.ok(notes.includes('Flight sequence: 2 · Backup: Sam'));
  });

  it('is told once per read, after the flights are applied, and a failure in it cannot fail the read', async () => {
    hookFails = true;
    const outcome = await refresher.refresh(panel());
    await settle(40);
    assert.equal(hookCalls, 1);
    assert.equal(outcome.added, 4, 'the flights were applied all the same');
    assert.equal(panel().lastRefreshError, null);
  });

  it('is not told anything when the read itself fails', async () => {
    const failing = new SourceRefresher(h.store, h.jobs, () => ({ kind: 'bad', fetch: async () => Promise.reject(new Error('boom')) }), undefined, () => h.clock.now, null, undefined, async () => void hookCalls++);
    await assert.rejects(failing.refresh(panel()));
    await settle(40);
    assert.equal(hookCalls, 0);
  });
});
