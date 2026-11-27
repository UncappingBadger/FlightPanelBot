import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseSheetCsv, parseSheetDate } from '../src/jobs/sheet.js';
import type { FetchedJobs, JobSource } from '../src/jobs/types.js';
import { matchNumbers } from '../src/services/aeroNumbers.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { silentLogger } from '../src/util/log.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';

const DAY = 24 * HOUR;
const HEADER = 'Flight Number,Route,Date,Landing Window Zulu,Pilot,Aircraft,Flight Completed (by Pilot)';
interface Row {
  no?: string;
  route: string;
  day?: string;
  window?: string;
  pilot?: string;
  aircraft?: string;
  done?: boolean;
}
const line = (r: Row) => `${r.no ?? ''},${r.route},${r.day ?? '11/12/2026'},${r.window ?? '0600-2359z'},${r.pilot ?? ''},${r.aircraft ?? 'A320'},${r.done ? 'TRUE' : 'FALSE'}`;
const csv = (rows: Row[], header = HEADER) => [header, ...rows.map(line)].join('\n');

describe("an airline's own heading for its flight numbers", () => {
  const read = (heading: string) => parseSheetCsv(csv([{ no: 'SKY123', route: 'EGLL-EGKK' }], HEADER.replace('Flight Number', heading)), T0);

  it('reads a column headed with the airline name before "Flight #"', () => {
    for (const heading of ['SKY Airways Flight #', 'SkyAir Flight #', 'SKY Flight Number', 'Airline Flight No.', 'SKY Flt #', 'SKY Flight ID']) {
      assert.equal(read(heading).jobs[0]!.flightNumber, 'SKY123', heading);
    }
  });

  it('does not take other headings with "flight" in them for the number', () => {
    for (const heading of ['Daily Flight Sequence', 'Flight Time', 'Flights', 'Next Flight', 'Flight Number Notes']) {
      assert.equal(read(heading).jobs[0]!.flightNumber ?? null, null, heading);
    }
  });

  it('prefers a column headed exactly "Flight Number" over a prefixed one', () => {
    const { jobs } = parseSheetCsv('SKY Flight #,Flight Number,Route,Date,Landing Window Zulu\nOLD1,SKY123,EGLL-EGKK,11/12/2026,0600-2359z', T0);
    assert.equal(jobs[0]!.flightNumber, 'SKY123');
  });

  it("never offers a prefixed column's empty cells to be filled in: it is the airline's own column", () => {
    const own = parseSheetCsv(csv([{ route: 'EGLL-EGKK' }], HEADER.replace('Flight Number', 'SKY Airways Flight #')), T0);
    assert.equal(own.blankFlightNumbers, undefined);
    const plain = parseSheetCsv(csv([{ route: 'EGLL-EGKK' }]), T0);
    assert.equal(plain.blankFlightNumbers?.length, 1, 'the documented column is still filled in, as before');
  });

  it("does not put Aeroconomy's number on a row whose own cell says something that cannot be used", () => {
    const { jobs } = parseSheetCsv(csv([{ no: 'SKY9', route: 'EGLL-EGKK' }, { no: 'SKY9', route: 'EGKK-EGLL' }]), T0);
    assert.deepEqual(jobs.map((j) => j.flightNumber), [null, null], 'the same number twice on a day names neither');
    const start = Date.UTC(2026, 10, 12, 6, 0);
    const flights = [{ number: 'SKY77', dep: 'EGLL', arr: 'EGKK', start, end: Date.UTC(2026, 10, 12, 23, 59), status: 'planned' }];
    assert.equal(matchNumbers(jobs, flights)[0]!.state, 'own');
  });

  it('reads a date written 11-12-26, as a sheet shows it after a change of format', () => {
    assert.deepEqual(parseSheetDate('11-12-26'), { y: 2026, m: 11, d: 12 });
    assert.deepEqual(parseSheetDate('11-12-2026'), { y: 2026, m: 11, d: 12 });
    assert.deepEqual(parseSheetDate('13-11-2026'), { y: 2026, m: 11, d: 13 });
  });

  it('keeps the same key for a flight when an earlier row of the same route and day is no longer read', () => {
    const rows: Row[] = [{ route: 'EGLL-EGKK', window: '0000-0100z' }, { route: 'EGLL-EGKK', window: '0600-2359z' }];
    const before = parseSheetCsv(csv(rows), T0).jobs.map((j) => j.key);
    assert.deepEqual(before, ['EGLL-EGKK@2026-11-12', 'EGLL-EGKK@2026-11-12#2']);
    const later = parseSheetCsv(csv(rows), Date.UTC(2026, 10, 15, 2, 0)).jobs.map((j) => j.key);
    assert.deepEqual(later, ['EGLL-EGKK@2026-11-12#2']);
  });
});

describe('the number on Discord is the number on the sheet', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });
  const pid = () => h.panel.id;
  const sync = (rows: Row[]) => h.jobs.sync(pid(), parseSheetCsv(csv(rows), h.clock.now).jobs);
  const open = () => h.jobs.open(pid());
  /** "route=ID" of every open flight, by route. */
  const shown = () => open().map((v) => `${v.legs[0]!.dep}-${v.legs[0]!.arr}${v.job.aircraft === 'A320' ? '' : ` ${v.job.aircraft}`}=${v.job.code}`).sort();
  const holderOf = (code: string) => open().find((v) => v.job.code === code)?.legs[0]?.holder?.discordId ?? null;
  const reserve = (code: string, user = USER_A) => h.jobs.reserve(open().find((v) => v.job.code === code)!.job.id, [1], user);

  it('gives a flight its number even though a flight that has been and gone had it', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK', day: '11/11/2026', window: '0600-1300z' }]);
    h.clock.advance(2 * HOUR);
    h.jobs.expireDue();
    const result = sync([{ no: 'SKY1', route: 'EGLL-EGKK', day: '11/18/2026' }]);
    assert.deepEqual(shown(), ['EGLL-EGKK=SKY1']);
    assert.deepEqual(result.numberClashes, []);
    const old = h.store.listJobs(pid()).find((j) => j.sourceKey === 'EGLL-EGKK@2026-11-11')!;
    assert.equal(old.code, 'SKY1-11NOV', 'the one that is over is known by its day');
  });

  it('keeps the number on a flight moved to another day', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK', day: '11/12/2026' }]);
    sync([{ no: 'SKY1', route: 'EGLL-EGKK', day: '11/13/2026' }]);
    assert.deepEqual(shown(), ['EGLL-EGKK=SKY1']);
  });

  it('keeps the number on a flight whose route was corrected', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK' }]);
    sync([{ no: 'SKY1', route: 'EGLL-EGSS' }]);
    assert.deepEqual(shown(), ['EGLL-EGSS=SKY1']);
  });

  it('tells the holder of a flight that is gone by the number they knew, even if another row has taken it', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK' }]);
    reserve('SKY1');
    h.emitted.length = 0;
    sync([{ no: 'SKY1', route: 'EGLL-EGSS' }]);
    const released = h.emitted.flatMap((e) => (e.type === 'released' ? [e.notice] : []));
    assert.deepEqual(released.map((n) => [n.jobCode, n.discordId, n.reason]), [['SKY1', USER_A.discordId, 'removed']]);
  });

  it('follows numbers swapped between two flights, and the reservation stays with its route', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK' }, { no: 'SKY2', route: 'EGKK-EGLL' }]);
    reserve('SKY1');
    const result = sync([{ no: 'SKY2', route: 'EGLL-EGKK' }, { no: 'SKY1', route: 'EGKK-EGLL' }]);
    assert.deepEqual(shown(), ['EGKK-EGLL=SKY1', 'EGLL-EGKK=SKY2']);
    assert.equal(holderOf('SKY2'), USER_A.discordId);
    assert.equal(holderOf('SKY1'), null);
    assert.equal(result.updated, 2);
  });

  it('follows numbers moved down a column, whichever row is read first', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK' }, { no: 'SKY2', route: 'EGKK-EGCC' }]);
    sync([{ no: 'SKY2', route: 'EGLL-EGKK' }, { no: 'SKY3', route: 'EGKK-EGCC' }]);
    assert.deepEqual(shown(), ['EGKK-EGCC=SKY3', 'EGLL-EGKK=SKY2']);
  });

  it('gives a number to the row it moved to, and the row it left an automatic ID', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK' }, { route: 'EGKK-EGCC' }]);
    sync([{ route: 'EGLL-EGKK' }, { no: 'SKY1', route: 'EGKK-EGCC' }]);
    assert.equal(shown()[0], 'EGKK-EGCC=SKY1');
    assert.match(shown()[1]!, /^EGLL-EGKK=TST-\d{3}$/);
  });

  it('keeps the reservation with its number when two flights of one route and day are re-ordered', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK', aircraft: 'A320' }, { no: 'SKY2', route: 'EGLL-EGKK', aircraft: 'B738' }]);
    reserve('SKY1');
    sync([{ no: 'SKY2', route: 'EGLL-EGKK', aircraft: 'B738' }, { no: 'SKY1', route: 'EGLL-EGKK', aircraft: 'A320' }]);
    assert.deepEqual(shown(), ['EGLL-EGKK B738=SKY2', 'EGLL-EGKK=SKY1']);
    assert.equal(holderOf('SKY1'), USER_A.discordId);
    const one = open().find((v) => v.job.code === 'SKY1')!;
    assert.equal(one.job.sourceKey, 'EGLL-EGKK@2026-11-12#2', 'the write to the sheet goes to the row it is on now');
  });

  it('releases only the flight that was taken out when the first of two of one route and day is deleted', () => {
    sync([{ no: 'SKY1', route: 'EGLL-EGKK' }, { no: 'SKY2', route: 'EGLL-EGKK' }]);
    reserve('SKY1', USER_A);
    reserve('SKY2', USER_B);
    h.emitted.length = 0;
    sync([{ no: 'SKY2', route: 'EGLL-EGKK' }]);
    assert.deepEqual(shown(), ['EGLL-EGKK=SKY2']);
    assert.equal(holderOf('SKY2'), USER_B.discordId);
    const released = h.emitted.flatMap((e) => (e.type === 'released' ? [e.notice] : []));
    assert.deepEqual(released.map((n) => [n.jobCode, n.discordId]), [['SKY1', USER_A.discordId]]);
  });

  it('knows two rows of one route and day apart by the pilot written on them when they have no numbers', () => {
    sync([{ route: 'EGLL-EGKK' }, { route: 'EGLL-EGKK' }]);
    const second = open().find((v) => v.job.sourceKey.endsWith('#2'))!;
    h.jobs.reserve(second.job.id, [1], USER_A);
    h.store.setReservationSheetName(second.job.id, 1, 'alice');
    // the bot's write is on the second row, and the rows are then re-ordered
    sync([{ route: 'EGLL-EGKK', pilot: 'alice' }, { route: 'EGLL-EGKK' }]);
    const after = h.jobs.view(second.job.id)!;
    assert.equal(after.job.sourceKey, 'EGLL-EGKK@2026-11-12');
    assert.equal(after.legs[0]!.holder?.discordId, USER_A.discordId);
  });

  it('shows an automatic ID, not another number, when the sheet gives two flights of a day the same number', () => {
    sync([{ no: 'SKY77', route: 'EGLL-EGKK' }, { no: 'SKY88', route: 'EGKK-EGLL' }]);
    sync([{ no: 'SKY9', route: 'EGLL-EGKK' }, { no: 'SKY9', route: 'EGKK-EGLL' }]);
    for (const s of shown()) assert.match(s, /=TST-\d{3}$/);
  });
});

describe('a read of the schedule that finds nothing', () => {
  let h: Harness;
  let next: FetchedJobs;
  let refresher: SourceRefresher;
  const source: JobSource = { kind: 'google-sheet', fetch: async () => next };
  const flights = (n: number) => Array.from({ length: n }, (_, i) => sj(`k${i}`, 'EGLL-EGKK', { deadline: T0 + 2 * DAY }));

  beforeEach(async () => {
    h = await makeHarness();
    refresher = new SourceRefresher(h.store, h.jobs, () => source, silentLogger, () => h.clock.now);
  });
  afterEach(async () => {
    await h.close();
  });
  const open = () => h.jobs.open(h.panel.id);

  it('keeps the flights and reservations when every row has become unreadable, and says why', async () => {
    next = { jobs: flights(2), warnings: [] };
    await refresher.refresh(h.panel);
    h.jobs.reserve(open()[0]!.job.id, [1], USER_A);
    next = { jobs: [], warnings: ['row 2 (EGLL-EGKK): the date "12.11.26" isn\'t a date'] };
    await assert.rejects(refresher.refresh(h.panel), /no flights/i);
    assert.equal(open().length, 2);
    assert.equal(open()[0]!.legs[0]!.holder?.discordId, USER_A.discordId);
    assert.match(h.store.getPanel(h.panel.id)!.lastRefreshError!, /12\.11\.26/);
  });

  it('keeps them when the sheet suddenly has no rows at all, with several flights still to come', async () => {
    next = { jobs: flights(3), warnings: [] };
    await refresher.refresh(h.panel);
    next = { jobs: [], warnings: [] };
    await assert.rejects(refresher.refresh(h.panel), /no flights/i);
    assert.equal(open().length, 3);
  });

  it('still empties a panel whose only flight was taken out of the sheet', async () => {
    next = { jobs: flights(1), warnings: [] };
    await refresher.refresh(h.panel);
    next = { jobs: [], warnings: [] };
    await refresher.refresh(h.panel);
    assert.equal(open().length, 0);
  });
});
