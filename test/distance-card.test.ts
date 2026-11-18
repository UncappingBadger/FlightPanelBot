import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MIGRATIONS } from '../src/db/db.js';
import { Store, type AirportCoord } from '../src/db/store.js';
import { completedCard, openCard } from '../src/discord/ui.js';
import { parseDistanceNm, parseSheetCsv } from '../src/jobs/sheet.js';
import type { FetchedJobs, JobSource, SourceJob } from '../src/jobs/types.js';
import { greatCircleNm } from '../src/services/airports.js';
import { DistanceFiller, routeDistanceNm } from '../src/services/distanceFill.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { makeHarness, sj, T0, type Harness } from './helpers.js';

/* Everything below is made up: the airline, its flights and its sheet. */

const POS: Record<string, AirportCoord> = {
  EGLL: { lat: 51.4706, lon: -0.4619, name: 'London Heathrow' },
  EGKK: { lat: 51.1481, lon: -0.1903, name: 'London Gatwick' },
  KJFK: { lat: 40.6398, lon: -73.7789, name: 'New York JFK' },
  KBOS: { lat: 42.3643, lon: -71.0052, name: 'Boston' },
};
const known = (codes: string[]) => new Map(codes.filter((c) => POS[c]).map((c) => [c, POS[c]!]));
const gc = (a: string, b: string) => greatCircleNm(POS[a]!, POS[b]!);

/* ------------------------------------------------------------------ the number in the cell */

describe('reading a distance out of a cell', () => {
  it('takes a plain number, with or without thousands commas, a decimal, or the unit', () => {
    const cases: Array<[string, number]> = [['392', 392], ['1,177', 1177], ['392.5', 392.5], ['392 nm', 392], ['392NM', 392], ['1,177 nmi', 1177], ['  60  ', 60]];
    for (const [text, want] of cases) assert.equal(parseDistanceNm(text), want, text);
  });

  it('reads a distance typed into a cell formatted as a date as the number it is: 427 shows as 3/2/1901', () => {
    const cases: Array<[string, number]> = [['3/2/1901', 427], ['5/29/1902', 880], ['5/17/1909', 3425], ['1901-03-02', 427], ['1/1/1900', 2], [' 3/2/1901 ', 427]];
    for (const [text, want] of cases) assert.equal(parseDistanceNm(text), want, text);
  });

  it('does not take a real date for a distance: anything from 1970 on, the zero date, or one too far back to be a distance', () => {
    for (const text of ['11/12/2026', '1/1/1970', '5/17/2009', '12/30/1899', '12/29/1899', '1/1/1969', '2026-11-12']) assert.equal(parseDistanceNm(text), null, text);
  });

  it('takes nothing from an empty cell, a note, zero, a negative, or something that is not a distance', () => {
    for (const text of ['', ' ', 'TBD', '#N/A', '0', '0.0', '-5', '12 km', '1e3', '5 6', 'about 300', '$300', '25,001', '999999']) assert.equal(parseDistanceNm(text), null, JSON.stringify(text));
    assert.equal(parseDistanceNm(null), null);
    assert.equal(parseDistanceNm(undefined), null);
    assert.equal(parseDistanceNm('25,000'), 25000);
  });
});

const HEADER = 'Route,Distance (NM),Date,Landing Window Zulu,Pilot,Aircraft,Flight Completed (by Pilot)';
const sheet = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('a schedule sheet\'s Distance column', () => {
  const read = (csv: string) => new Map(parseSheetCsv(csv, T0).jobs.map((j) => [j.key, j]));

  it('gives a flight the distance the cell holds', () => {
    const jobs = read(sheet('EGLL-EGKK,24,11/12/2026,0600-2359z,,A320,FALSE', 'EGKK-EGLL,"1,177 nm",11/12/2026,0600-2359z,,A320,FALSE', 'EGLL-KJFK,,11/12/2026,0600-2359z,,A320,FALSE', 'KJFK-EGLL,TBD,11/12/2026,0600-2359z,,A320,FALSE'));
    assert.deepEqual([...jobs.values()].map((j) => j.distanceNm), [24, 1177, null, null]);
  });

  it('reads a distance the sheet shows as a date, and does not offer that cell to be filled in', () => {
    const csv = sheet('EGLL-EGKK,3/2/1901,11/12/2026,0600-2359z,,A320,FALSE', 'EGKK-EGLL,,11/12/2026,0600-2359z,,A320,FALSE');
    const read = parseSheetCsv(csv, T0);
    assert.deepEqual(read.jobs.map((j) => j.distanceNm), [427, null]);
    assert.deepEqual(read.blankDistances, ['EGKK-EGLL@2026-11-12']);
  });

  it('gives none to a sheet without such a column', () => {
    const csv = 'Route,Date,Landing Window Zulu,Pilot,Aircraft,Flight Completed (by Pilot)\nEGLL-EGKK,11/12/2026,0600-2359z,,A320,FALSE';
    assert.deepEqual([...read(csv).values()].map((j) => j.distanceNm), [null]);
  });
});

/* ------------------------------------------------------------------ keeping it with the flight */

describe('a flight keeps its distance', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  const job = () => h.store.listJobs(h.panel.id)[0]!;

  it('has the distance its source gave, and none when the source gave none', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { distanceNm: 24.4 }), sj('b', 'EGLL-KJFK')]);
    const [a, b] = h.store.listJobs(h.panel.id);
    assert.deepEqual([a!.distanceNm, b!.distanceNm], [24.4, null]);
  });

  it('is updated when the distance changes, counted as an update, and cleared when the source stops giving one', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { distanceNm: 24 })]);
    const same = h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { distanceNm: 24 })]);
    assert.equal(same.updated, 0, 'the same distance is not a change');
    const changed = h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { distanceNm: 31 })]);
    assert.equal(changed.updated, 1);
    assert.equal(job().distanceNm, 31);
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    assert.equal(job().distanceNm, null);
  });
});

describe('the database upgrade that adds the distance', () => {
  it('upgrades a v31 database: existing flights have no distance, and can be given one', () => {
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < 31; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    old.prepare(`INSERT INTO jobs(panel_id, code, source_key, status, first_seen, last_seen) VALUES (1, 'OLD-001', 'k', 'open', 1, 1)`).run();
    assert.ok(MIGRATIONS.length >= 32);
    old.exec(MIGRATIONS[31] as string);
    const store = new Store(old);
    const before = store.listJobs(1)[0]!;
    assert.equal(before.distanceNm, null);
    store.updateJob(before.id, { distanceNm: 1177 });
    assert.equal(store.getJob(before.id)!.distanceNm, 1177);
  });
});

/* ------------------------------------------------------------------ on the card */

describe('the distance on a flight\'s card', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  const view = (key = 'a') => h.jobs.open(h.panel.id).find((v) => v.job.sourceKey === key)!;
  const lines = (key = 'a') => (openCard(view(key), T0).toJSON().description ?? '').split('\n');

  it('is small type on the line under the route', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-KJFK', { distanceNm: 2991.4 })]);
    assert.deepEqual(lines(), ['## EGLL ✈ KJFK', '-# 📏 2,991 nm']);
  });

  it('comes between the route and the notes', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { distanceNm: 24, notes: 'Flight sequence: 2', title: 'Hop' })]);
    assert.deepEqual(lines(), ['## EGLL ✈ EGKK', '-# 📏 24 nm', '*Hop - Flight sequence: 2*']);
  });

  it('is left out when the distance is nothing at all', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { distanceNm: 0 })]);
    assert.deepEqual(lines(), ['## EGLL ✈ EGKK']);
  });

  it('is left out when the distance is not known', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    assert.deepEqual(lines(), ['## EGLL ✈ EGKK']);
  });

  it('says it is for the whole flight when there are several legs', () => {
    h.jobs.sync(h.panel.id, [sj('m', 'EGLL-KJFK-KBOS', { distanceNm: 3180 })]);
    assert.deepEqual(lines('m'), ['## EGLL → KJFK → KBOS'.replace(/ → /g, ' ✈ '), '-# 📏 3,180 nm in all']);
  });

  it('shows a very long and a very short distance as whole numbers', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { distanceNm: 0.4 }), sj('b', 'EGLL-KJFK', { distanceNm: 12345.6 })]);
    assert.deepEqual(lines('a'), ['## EGLL ✈ EGKK', '-# 📏 0 nm']);
    assert.equal(lines('b')[1], '-# 📏 12,346 nm');
  });

  it('is on a completed flight\'s card too', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-KJFK', { distanceNm: 2991 }), sj('b', 'EGLL-EGKK')]);
    assert.deepEqual((completedCard(view('a')).toJSON().description ?? '').split('\n'), ['## EGLL ✈ KJFK', '-# 📏 2,991 nm']);
    assert.deepEqual((completedCard(view('b')).toJSON().description ?? '').split('\n'), ['## EGLL ✈ EGKK']);
  });
});

/* ------------------------------------------------------------------ working it out for the card */

const job = (key: string, legs: Array<[string, string]>, distanceNm?: number | null): SourceJob => ({ key, title: null, legs: legs.map(([dep, arr]) => ({ dep, arr })), aircraft: null, availableFrom: null, deadline: null, pay: null, notes: null, ...(distanceNm !== undefined ? { distanceNm } : {}) });
const withColumn = (jobs: SourceJob[]): FetchedJobs => ({ jobs, warnings: [], blankDistances: [] });

describe('the distance worked out for a card', () => {
  let filler: DistanceFiller;
  let asked: string[][];
  const panel = {} as never;
  beforeEach(() => {
    asked = [];
    filler = new DistanceFiller({
      writeback: null,
      airports: { coords: async () => new Map() },
      positions: (codes) => (asked.push(codes), new Map(Object.entries(POS))),
    });
  });

  it('is the sum of the great-circle distances of the legs, in whole nautical miles, null if any airport is unknown', () => {
    assert.equal(routeDistanceNm([{ dep: 'EGLL', arr: 'EGKK' }], known(['EGLL', 'EGKK'])), Math.round(gc('EGLL', 'EGKK')));
    assert.equal(routeDistanceNm([{ dep: 'EGLL', arr: 'KJFK' }, { dep: 'KJFK', arr: 'KBOS' }], known(['EGLL', 'KJFK', 'KBOS'])), Math.round(gc('EGLL', 'KJFK') + gc('KJFK', 'KBOS')));
    assert.equal(routeDistanceNm([{ dep: 'EGLL', arr: 'ZZZZ' }], known(['EGLL'])), null);
    assert.equal(routeDistanceNm([{ dep: 'EGLL', arr: 'EGKK' }, { dep: 'EGKK', arr: 'ZZZZ' }], known(['EGLL', 'EGKK'])), null);
    assert.equal(routeDistanceNm([{ dep: 'EGLL', arr: 'EGLL' }], known(['EGLL'])), null, 'no distance at all is none');
    assert.equal(routeDistanceNm([{ dep: ' egll ', arr: 'egkk' }], known(['EGLL', 'EGKK'])), Math.round(gc('EGLL', 'EGKK')), 'any case, tidied');
  });

  it('gives a flight whose cell is blank the distance worked out, and keeps the one the sheet gave', () => {
    const out = filler.enrich(panel, [job('a', [['EGLL', 'KJFK']]), job('b', [['EGLL', 'EGKK']], 999), job('c', [['EGLL', 'ZZZZ']])], withColumn([]));
    assert.deepEqual(out.map((j) => j.distanceNm ?? null), [Math.round(gc('EGLL', 'KJFK')), 999, null]);
  });

  it('asks only about the airports of the flights that lack a distance', () => {
    filler.enrich(panel, [job('a', [['EGLL', 'KJFK']]), job('b', [['EGKK', 'KBOS']], 500)], withColumn([]));
    assert.deepEqual(asked, [['EGLL', 'KJFK']]);
    asked.length = 0;
    filler.enrich(panel, [job('b', [['EGKK', 'KBOS']], 500)], withColumn([]));
    assert.deepEqual(asked, [], 'nothing to ask when every flight has one');
  });

  it('leaves the flights alone, and unchanged, for a source with no Distance column', () => {
    const jobs = [job('a', [['EGLL', 'KJFK']])];
    const out = filler.enrich(panel, jobs, { jobs, warnings: [] });
    assert.equal(out, jobs);
    assert.deepEqual(asked, []);
  });

  it('does nothing when it has no way to find airports at once', () => {
    const none = new DistanceFiller({ writeback: null, airports: { coords: async () => new Map() } });
    const jobs = [job('a', [['EGLL', 'KJFK']])];
    assert.equal(none.enrich(panel, jobs, withColumn([])), jobs);
  });

  it('does not change the flights it is given', () => {
    const jobs = [job('a', [['EGLL', 'KJFK']])];
    filler.enrich(panel, jobs, withColumn([]));
    assert.equal(jobs[0]!.distanceNm, undefined);
  });

  it('counts a distance of nothing, as a source may give, as lacking one', () => {
    const out = filler.enrich(panel, [job('a', [['EGLL', 'KJFK']], null)], withColumn([]));
    assert.equal(out[0]!.distanceNm, Math.round(gc('EGLL', 'KJFK')));
  });
});

/* ------------------------------------------------------------------ reading the schedule shows it */

describe('reading the schedule shows the distance on the card', () => {
  let h: Harness;
  let refresher: SourceRefresher;
  let csv: string;
  const view = (key: string) => h.jobs.open(h.panel.id).find((v) => v.job.sourceKey === key)!;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    const filler = new DistanceFiller({ writeback: null, airports: { coords: async () => new Map() }, positions: known });
    const source: JobSource = { kind: 'google-sheet', fetch: async () => parseSheetCsv(csv, h.clock.now) };
    refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, () => h.clock.now, (p, list, fetched) => filler.enrich(p, list, fetched));
  });
  afterEach(() => h.close());

  it('uses the sheet\'s own distance, or works one out from the airports when the cell is blank', async () => {
    csv = sheet('EGLL-KJFK,,11/12/2026,0600-2359z,,A320,FALSE', 'EGLL-EGKK,30,11/12/2026,0600-2359z,,A320,FALSE');
    await refresher.refresh(h.store.getPanel(h.panel.id)!);
    assert.equal(view('EGLL-KJFK@2026-11-12').job.distanceNm, Math.round(gc('EGLL', 'KJFK')));
    assert.equal(view('EGLL-EGKK@2026-11-12').job.distanceNm, 30);
    const card = (openCard(view('EGLL-KJFK@2026-11-12'), T0).toJSON().description ?? '').split('\n');
    assert.equal(card[1], `-# 📏 ${Math.round(gc('EGLL', 'KJFK')).toLocaleString('en-US')} nm`);
  });

  it('shows nothing for a sheet with no Distance column', async () => {
    csv = 'Route,Date,Landing Window Zulu,Pilot,Aircraft,Flight Completed (by Pilot)\nEGLL-KJFK,11/12/2026,0600-2359z,,A320,FALSE';
    await refresher.refresh(h.store.getPanel(h.panel.id)!);
    assert.equal(view('EGLL-KJFK@2026-11-12').job.distanceNm, null);
  });

  it('follows the sheet when a manager types a different distance later', async () => {
    csv = sheet('EGLL-KJFK,,11/12/2026,0600-2359z,,A320,FALSE');
    await refresher.refresh(h.store.getPanel(h.panel.id)!);
    csv = sheet('EGLL-KJFK,"3,050",11/12/2026,0600-2359z,,A320,FALSE');
    await refresher.refresh(h.store.getPanel(h.panel.id)!);
    assert.equal(view('EGLL-KJFK@2026-11-12').job.distanceNm, 3050);
  });
});
