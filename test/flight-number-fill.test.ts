import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AeroContract, AeroFlight } from '../src/aeroconomy/client.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { parseScheduleValues, parseSheetCsv } from '../src/jobs/sheet.js';
import type { JobSource } from '../src/jobs/types.js';
import { AeroNumbers, matchNumbers } from '../src/services/aeroNumbers.js';
import { FlightNumberFiller } from '../src/services/flightNumberFill.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import { HOUR, makeHarness, T0, type Harness } from './helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up: the airline (FsHub airline 4242), its sheet, contracts and flights. */

const { account, publicKey } = makeServiceAccount();
const AIRLINE = 4242;

/** The columns of an airline's schedule sheet with a Flight Number column added after the route. */
const HEADER = ['Route', 'Flight Number', 'Date', 'Landing Window Zulu', 'Landing Window US Central', 'Pilot', 'Backup Pilot', 'Aircraft', 'Flight Completed (by Pilot)', 'Pilot Paid', 'Profit Made', 'Pilot Pay'];
interface RowOpts {
  number?: string;
  pilot?: string;
  done?: boolean;
}
const row = (route: string, date: string, o: RowOpts = {}): string[] => [route, o.number ?? '', date, '0600-2359z', 'Thu 0000 - Thu 1759 CT', o.pilot ?? '', '', 'A320', o.done ? 'TRUE' : 'FALSE', 'FALSE', '', ''];
const csvOf = (grid: string[][]) => grid.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

const KEYS = { a: 'EGLL-EGKK@2026-11-12', b: 'EGKK-EGLL@2026-11-12', c: 'EGLL-EGCC@2026-11-12', d: 'EGLL-EGCC@2026-11-13', old: 'EGLL-EGPH@2026-10-01', none: 'EGPH-EGLL@2026-11-12' };
const grid = (): string[][] => [
  HEADER,
  ['Week 2', '', 'Week 2'],
  row('EGLL-EGKK', '11/12/2026'), // row 3: blank, one Aeroconomy flight
  row('EGKK-EGLL', '11/12/2026', { number: 'OWN7' }), // row 4: has a number of its own
  row('EGLL-EGCC', '11/12/2026'), // row 5: blank, the same number is flown on two days
  row('EGLL-EGCC', '11/13/2026'), // row 6: blank, the other day
  row('EGLL-EGPH', '10/01/2026', { done: true, pilot: 'Sam' }), // row 7: flown weeks ago
  row('EGPH-EGLL', '11/12/2026'), // row 8: blank, but Aeroconomy has no such flight
];

const at = (y: number, m: number, d: number, h: number, min = 0, s = 0) => Date.UTC(y, m - 1, d, h, min, s);
const aero = (number: string, dep: string, arr: string, y: number, m: number, d: number, status = 'planned'): AeroFlight => ({ number, dep, arr, start: at(y, m, d, 6), end: at(y, m, d, 23, 59, 59), status });
const FLIGHTS: AeroFlight[] = [
  aero('SKY290', 'EGLL', 'EGKK', 2026, 11, 12),
  aero('SKY300', 'EGKK', 'EGLL', 2026, 11, 12),
  aero('SKY330', 'EGLL', 'EGCC', 2026, 11, 12),
  aero('SKY330', 'EGLL', 'EGCC', 2026, 11, 13),
  aero('SKY100', 'EGLL', 'EGPH', 2026, 10, 1, 'completed'),
];

/* ------------------------------------------------------------------ reading the empty cells */

describe('finding the empty Flight Number cells of a sheet', () => {
  const read = (g = grid()) => parseSheetCsv(csvOf(g), T0);

  it('lists every row whose Flight Number cell is empty, a row flown weeks ago included, with what is needed to find its number', () => {
    const got = read().blankFlightNumbers!;
    assert.deepEqual(got.map((r) => r.key), [KEYS.a, KEYS.c, KEYS.d, KEYS.old, KEYS.none]);
    assert.deepEqual(got[0], { key: KEYS.a, legs: [{ dep: 'EGLL', arr: 'EGKK' }], availableFrom: at(2026, 11, 12, 6), deadline: at(2026, 11, 12, 23, 59) });
  });

  it('keeps the panel\'s own list of flights as it was: a row flown weeks ago is still not one of them', () => {
    const r = read();
    assert.equal(r.jobs.some((j) => j.key === KEYS.old), false);
    assert.equal(parseScheduleValues(grid(), T0)!.rowOf.has(KEYS.old), false);
    assert.equal(parseScheduleValues(grid(), T0, true)!.rowOf.has(KEYS.old), true, 'but a read of every row finds it');
  });

  it('does not list a cell with a number, a note or a stray space', () => {
    const g = grid();
    g[2]![1] = 'TBD';
    g[4]![1] = ' ';
    assert.deepEqual(read(g).blankFlightNumbers!.map((r) => r.key), [KEYS.d, KEYS.old, KEYS.none]);
  });

  it('knows nothing of flight numbers when the sheet has no such column, and takes the other names such a column goes by', () => {
    assert.equal(read(grid().map((r) => r.filter((_, i) => i !== 1))).blankFlightNumbers, undefined);
    for (const name of ['Flight No', 'Flight #', 'Flight ID', 'Flt No']) {
      const g = grid();
      g[0] = g[0]!.map((c) => (c === 'Flight Number' ? name : c));
      assert.equal(read(g).blankFlightNumbers?.length, 5, name);
    }
  });
});

/* ------------------------------------------------------------------ which number goes with which row */

describe('the flight number of a row', () => {
  const jobs = (keys: string[]) => keys.map((k) => ({ legs: [{ dep: k.slice(0, 4), arr: k.slice(5, 9) }], availableFrom: at(2026, 11, Number(k.slice(-2)), 6), deadline: at(2026, 11, Number(k.slice(-2)), 23, 59) }));

  it('is the number itself, without the day, even for a number flown on several days (the sheet reader adds the day to those by itself)', () => {
    const m = matchNumbers(jobs([KEYS.c, KEYS.d]), FLIGHTS);
    assert.deepEqual(m.map((x) => [x.state, x.number, x.code]), [['numbered', 'SKY330', 'SKY330-12NOV'], ['numbered', 'SKY330', 'SKY330-13NOV']]);
  });

  it('is nothing for a flight that is not exactly one published flight', () => {
    const m = matchNumbers(jobs([KEYS.none, KEYS.a, KEYS.a]), FLIGHTS);
    assert.deepEqual(m.map((x) => [x.state, x.number]), [['none', null], ['ambiguous', null], ['ambiguous', null]]);
  });
});

/* ------------------------------------------------------------------ writing them */

describe('writing flight numbers into the sheet', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  const panel = () => h.store.getPanel(h.panel.id)!;
  /** What the pretend Aeroconomy says each row is: by the row's key. */
  const wanted = new Map<string, string>([
    [KEYS.a, 'SKY290'],
    [KEYS.b, 'SKY300'],
    [KEYS.c, 'SKY330'],
    [KEYS.d, 'SKY330'],
    [KEYS.old, 'SKY100'],
  ]);
  const numbersFor = (rows: Array<{ key: string }>) => rows.map((r) => wanted.get(r.key) ?? null);

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

  it('writes each number into the empty Flight Number cell of its own row, as text, in one request, and touches nothing else', async () => {
    const before = g.values.map((r) => [...r]);
    const got = await wb.fillFlightNumbers(panel(), numbersFor);
    assert.equal(got.written, 4, 'three recent rows and the one flown weeks ago; not the row with a number of its own, nor the one with no number to give');
    assert.equal(g.writes.length, 1);
    assert.equal(g.writes[0]!.valueInputOption, 'RAW');
    assert.deepEqual(g.writes[0]!.data.map((d) => [d.range.split('!')[1], d.values[0]![0]]), [['B3', 'SKY290'], ['B5', 'SKY330'], ['B6', 'SKY330'], ['B7', 'SKY100']]);
    for (let r = 0; r < before.length; r++) for (let c = 0; c < before[r]!.length; c++) if (!(c === 1 && [2, 4, 5, 6].includes(r))) assert.equal(g.values[r]![c] ?? '', before[r]![c] ?? '', `row ${r + 1} column ${c}`);
    assert.equal(g.cell('B4'), 'OWN7', 'a number of its own is never replaced');
  });

  it('is given only the rows whose cell is empty', async () => {
    let asked: string[] = [];
    await wb.fillFlightNumbers(panel(), (rows) => ((asked = rows.map((r) => r.key)), rows.map(() => null)));
    assert.deepEqual(asked, [KEYS.a, KEYS.c, KEYS.d, KEYS.old, KEYS.none]);
    assert.equal(g.writes.length, 0, 'and nothing is written when it has no numbers to give');
  });

  it('never replaces a cell that has anything in it: a number, a note, a stray space, or a formula', async () => {
    const attempt = async (setup: () => void) => {
      g.values = grid();
      g.formulas.clear();
      g.writes.length = 0;
      setup();
      return wb.fillFlightNumbers(panel(), (rows) => rows.map((r) => (r.key === KEYS.a ? 'SKY290' : null)));
    };
    for (const [what, setup] of [
      ['a number', () => void (g.values[2]![1] = 'SKY1')],
      ['a note', () => void (g.values[2]![1] = 'TBD')],
      ['a stray space', () => void (g.values[2]![1] = ' ')],
      ['a formula that shows nothing', () => void g.formulas.set('B3', '=IF(1=2,1,"")')],
      ['a formula with a value', () => void ((g.values[2]![1] = 'SKY9'), g.formulas.set('B3', '="SKY"&9'))],
    ] as Array<[string, () => void]>) {
      const got = await attempt(setup);
      assert.equal(got.written, 0, what);
      assert.equal(g.writes.length, 0, `${what}: not even a request`);
      assert.notEqual(g.cell('B3'), 'SKY290', what);
    }
    assert.equal((await attempt(() => undefined)).written, 1, 'a truly empty cell still is filled');
  });

  it('writes only what is still empty when it looks, so a manager who typed one meanwhile is not overwritten', async () => {
    g.beforeNextRead = () => {
      g.values[2]![1] = 'SKY555';
    };
    const got = await wb.fillFlightNumbers(panel(), numbersFor);
    assert.equal(g.cell('B3'), 'SKY555');
    assert.equal(got.written, 3);
  });

  it('finds the rows again when they have moved', async () => {
    g.values.splice(2, 0, row('EGLL-EGPH', '11/14/2026')); // a row inserted above: every row below moves down
    await wb.fillFlightNumbers(panel(), (rows) => rows.map((r) => (r.key === KEYS.a ? 'SKY290' : null)));
    assert.equal(g.cell('B4'), 'SKY290', 'the row it is on now');
    assert.equal(g.cell('B3'), '', 'not the row it used to be on');
  });

  it('does not give a flight a number that another row of the same flight already has', async () => {
    g.values.splice(3, 0, row('EGLL-EGKK', '11/12/2026', { number: 'SKY290' })); // a second row for the same flight, already numbered
    await wb.fillFlightNumbers(panel(), (rows) => rows.map((r) => (r.key === KEYS.a ? 'SKY290' : null)));
    assert.equal(g.cell('B3'), '', 'it would have made two rows of one flight share a number');
    assert.equal(g.writes.length, 0);
  });

  it('asks nothing of Google when the tab has no Flight Number column, and says so when Google refuses', async () => {
    g.values = grid().map((r) => r.filter((_, i) => i !== 1));
    assert.deepEqual(await wb.fillFlightNumbers(panel(), numbersFor), { written: 0 });
    assert.equal(g.writes.length, 0);
    g.values = grid();
    g.mode = 'view-only';
    await assert.rejects(wb.fillFlightNumbers(panel(), numbersFor), (e: unknown) => e instanceof WriteBackError && e.code === 'GOOGLE');
    h.store.updatePanel(h.panel.id, { sheetId: null, sheetGid: null });
    await assert.rejects(wb.fillFlightNumbers(panel(), numbersFor), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_SHEET');
  });
});

/* ------------------------------------------------------------------ when a schedule is read */

describe('filling the flight numbers as a schedule is read', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let numbers: AeroNumbers;
  let filler: FlightNumberFiller;
  let refresher: SourceRefresher;
  const pid = () => h.panel.id;
  const panel = () => h.store.getPanel(pid())!;
  const contracts: AeroContract[] = [{ id: 7, status: 'active', total: 5 }];
  const fakeClient = {
    async airlineContracts() {
      return contracts;
    },
    async manifests() {
      return FLIGHTS;
    },
  };
  /** The schedule as the bot's own reader gets it from the sheet. */
  const source: JobSource = { kind: 'sheet', fetch: async (_airline, now) => parseSheetCsv(csvOf(g.values), now) };
  const settleBackground = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = grid();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE, flightNumbers: true });
    numbers = new AeroNumbers({ store: h.store, client: fakeClient, now: () => h.clock.now });
    filler = new FlightNumberFiller({ writeback: wb, numbers });
    refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, () => h.clock.now, (p, list) => numbers.enrich(p, list), undefined, (p, fetched) => filler.run(p, fetched));
    await numbers.run();
    await numbers.idle();
  });
  afterEach(async () => {
    await numbers.idle();
    await h.close();
  });

  it('writes the numbers of the rows that are exactly one flight, into the sheet, once the schedule is read, and the next read finds them as the rows\' own', async () => {
    await refresher.refresh(panel());
    await settleBackground();
    assert.deepEqual([g.cell('B3'), g.cell('B4'), g.cell('B5'), g.cell('B6'), g.cell('B7'), g.cell('B8')], ['SKY290', 'OWN7', 'SKY330', 'SKY330', 'SKY100', '']);
    // The panel's flights already had these IDs from the same numbers: the cells say what the panel says.
    assert.deepEqual(h.store.listJobs(pid()).map((j) => j.code).sort(), ['OWN7', 'SKY290', 'SKY330-12NOV', 'SKY330-13NOV', 'TST-001'].sort());
    const writes = g.writes.length;
    h.clock.now += HOUR;
    await refresher.refresh(panel());
    await settleBackground();
    assert.equal(g.writes.length, writes, 'nothing left to write, and the IDs are what they were');
    assert.deepEqual(h.store.listJobs(pid()).map((j) => j.code).sort(), ['OWN7', 'SKY290', 'SKY330-12NOV', 'SKY330-13NOV', 'TST-001'].sort());
  });

  it('writes nothing for a panel that does not take Aeroconomy\'s numbers, one with write-back off, or one with no airline', async () => {
    const attempt = async (setup: () => void, reset: () => void) => {
      g.values = grid();
      g.writes.length = 0;
      setup();
      await refresher.refresh(panel());
      await settleBackground();
      reset();
      return g.writes.length;
    };
    assert.equal(await attempt(() => h.store.updatePanel(pid(), { flightNumbers: false }), () => h.store.updatePanel(pid(), { flightNumbers: true })), 0);
    assert.equal(await attempt(() => h.store.updatePanel(pid(), { writeback: false }), () => h.store.updatePanel(pid(), { writeback: true })), 0);
    assert.equal(await attempt(() => h.store.updatePanel(pid(), { fshubAirlineId: null }), () => h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE })), 0);
    assert.equal(await attempt(() => undefined, () => undefined), 1, 'and with them all in place, it does (one request)');
  });

  it('asks nothing of Google when none of the empty cells has a number to go in it', async () => {
    g.values = grid().filter((r, i) => i < 2 || r[0] === 'EGPH-EGLL'); // only the row Aeroconomy has no such flight for
    await refresher.refresh(panel());
    await settleBackground();
    assert.equal(g.calls.filter((c) => c.url.includes('/values/')).length, 0);
  });

  it('never lets a failed write fail the refresh, and tries again at the next one', async () => {
    g.mode = 'down';
    const out = await refresher.refresh(panel());
    await settleBackground();
    assert.ok(out.added >= 1, 'the schedule was still applied');
    assert.equal(g.cell('B3'), '');
    g.mode = 'ok';
    h.clock.now += HOUR;
    await refresher.refresh(panel());
    await settleBackground();
    assert.equal(g.cell('B3'), 'SKY290');
  });
});
