import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { localSheetFile, localSheetFetch } from '../src/google/localSheet.js';
import { parseSheetCsv, parseSheetUrl } from '../src/jobs/sheet.js';
import { PerfMonitor } from '../src/testbuild/perfMonitor.js';
import { TEST_SHEET_ID, TEST_SHEET_URL, TestSheetFeeder, startingCsv } from '../src/testbuild/testSheet.js';
import { TEST_BUILD, TIME_SCALE, appNow, scaledClock } from '../src/util/clock.js';
import type { Logger } from '../src/util/log.js';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const DAY = 86_400_000;

const recorder = () => {
  const lines: string[] = [];
  const log = { debug() {}, info: (m: string) => void lines.push(m), warn: (m: string) => void lines.push(`warn ${m}`), error: (m: string) => void lines.push(`error ${m}`) } as unknown as Logger;
  return { log, lines };
};

describe('the test build\'s clock', () => {
  it('runs as many times faster as it is told, from where it started', () => {
    let real = 1_000_000;
    const clock = scaledClock(288, 1_000_000, () => real);
    assert.equal(clock(), 1_000_000);
    real += 1_000; // one real second
    assert.equal(clock(), 1_000_000 + 288_000);
    real += 5 * 60_000 - 1_000; // five real minutes in all
    assert.equal(clock() - 1_000_000, DAY, 'a day');
    real = 1_000_000 + 12_500; // twelve and a half seconds
    assert.equal(clock() - 1_000_000, 3_600_000, 'an hour');
  });

  it('is the plain clock in every build but the test build (and in tests)', () => {
    assert.equal(TEST_BUILD, false);
    assert.equal(TIME_SCALE, 1);
    const real = Date.now();
    assert.ok(Math.abs(appNow() - real) < 1000, 'the same time as Date.now');
    const original = Date.now;
    Date.now = () => 42;
    try {
      assert.equal(appNow(), 42, 'and follows a Date.now that a test has replaced');
    } finally {
      Date.now = original;
    }
  });
});

describe('the made-up schedule', () => {
  it('is a schedule the bot reads without a complaint, with a distance and a flight number on every flight', () => {
    const fetched = parseSheetCsv(startingCsv(NOW), NOW);
    assert.ok(fetched.jobs.length >= 60, `${fetched.jobs.length} flights`);
    assert.deepEqual(fetched.warnings, []);
    assert.deepEqual(fetched.blankDistances, [], 'no distance is left for the bot to look up from the airport list (which would ask the internet)');
    assert.ok(fetched.jobs.every((j) => j.distanceNm && j.flightNumber && /^SKY\d+$/.test(j.flightNumber)));
    assert.equal(new Set(fetched.jobs.map((j) => j.flightNumber)).size, fetched.jobs.length, 'every flight number is its own');
    assert.ok(fetched.jobs.some((j) => j.completed), 'some are flown already');
    assert.ok(fetched.jobs.some((j) => j.legs.length === 2), 'and some have two legs');
  });

  it('is the same every time for the same seed, and different for another', () => {
    assert.equal(startingCsv(NOW, 1), startingCsv(NOW, 1));
    assert.notEqual(startingCsv(NOW, 1), startingCsv(NOW, 2));
  });

  it('uses nothing but invented names', () => {
    const csv = startingCsv(NOW);
    assert.doesNotMatch(csv, /@|https?:/, 'no address or link of a real person or site');
    assert.match(csv, /SKY1000/);
  });

  it('has a sheet link the bot accepts', () => {
    assert.deepEqual(parseSheetUrl(TEST_SHEET_URL), { id: TEST_SHEET_ID, gid: null });
  });
});

describe('the feeder, which keeps the made-up schedule changing', () => {
  let dir: string;
  let clock: number;
  const refOf = { id: TEST_SHEET_ID, gid: null as string | null };
  const noInternet = (async () => {
    throw new Error('the test build asked the internet');
  }) as unknown as typeof fetch;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-feed-'));
    clock = NOW;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const boot = (seed = 7) => {
    const { log, lines } = recorder();
    const feeder = new TestSheetFeeder(dir, () => clock, { seed, logger: log });
    const fetchFn = localSheetFetch(dir, noInternet, log, feeder.make);
    return { feeder, fetchFn, lines };
  };
  const read = async (fetchFn: typeof fetch) => parseSheetCsv(await (await fetchFn(`https://docs.google.com/spreadsheets/d/${TEST_SHEET_ID}/export?format=csv`)).text(), clock);

  it('makes the schedule of a sheet link the first time it is read, without asking Google', async () => {
    const { fetchFn, lines } = boot();
    const first = await read(fetchFn);
    assert.ok(first.jobs.length > 50);
    assert.ok(existsSync(localSheetFile(dir, refOf)));
    assert.ok(lines.some((l) => /made up a schedule/.test(l)));
    const again = await read(fetchFn);
    assert.deepEqual(again.jobs.map((j) => j.key), first.jobs.map((j) => j.key), 'and keeps it');
  });

  it('adds days at the end as time goes on, so there are always flights ahead', async () => {
    const { feeder, fetchFn } = boot();
    const before = await read(fetchFn);
    const last = Math.max(...before.jobs.map((j) => j.availableFrom ?? 0));
    clock += 3 * DAY;
    const r = feeder.feed();
    assert.ok(r.added > 10, `${r.added} flights added`);
    const after = await read(fetchFn);
    assert.ok(Math.max(...after.jobs.map((j) => j.availableFrom ?? 0)) >= last + 2 * DAY);
    assert.deepEqual(after.warnings, []);
    assert.equal(new Set(after.jobs.map((j) => j.flightNumber)).size, after.jobs.length, 'flight numbers stay their own');
  });

  it('has pilots put their names against flights, ticks flown flights, and cancels a few, and what it makes is still readable', async () => {
    const { feeder, fetchFn } = boot();
    await read(fetchFn);
    let signedUp = 0;
    let completed = 0;
    let cancelled = 0;
    for (let hour = 0; hour < 24 * 6; hour++) {
      clock += 3_600_000;
      const r = feeder.feed();
      signedUp += r.signedUp;
      completed += r.completed;
      cancelled += r.cancelled;
    }
    assert.ok(signedUp >= 20, `${signedUp} sign-ups`);
    assert.ok(completed >= 10, `${completed} flights ticked`);
    assert.ok(cancelled >= 1, `${cancelled} cancelled`);
    const now = await read(fetchFn);
    assert.deepEqual(now.warnings, []);
    assert.ok(now.jobs.some((j) => j.legs[0]?.heldBy), 'some flights have a pilot');
  });

  it('never writes over a name that is already in a cell (a pilot who reserved in Discord, or a person who typed it)', async () => {
    const { feeder, fetchFn } = boot();
    await read(fetchFn);
    // The flights that already have a pilot (the days gone by were flown by somebody) keep that pilot however long the feeder runs.
    const before = (await read(fetchFn)).jobs.filter((j) => j.legs[0]?.heldBy).map((j) => [j.key, j.legs[0]!.heldBy]);
    for (let i = 0; i < 48; i++) {
      clock += 3_600_000;
      feeder.feed();
    }
    const after = new Map((await read(fetchFn)).jobs.map((j) => [j.key, j.legs[0]?.heldBy]));
    for (const [key, name] of before) if (after.has(key as string)) assert.equal(after.get(key as string), name, `${key} kept its pilot`);
  });

  it('is repeatable: the same seed makes the same changes', async () => {
    const run = async () => {
      rmSync(dir, { recursive: true, force: true });
      clock = NOW;
      const { feeder, fetchFn } = boot(11);
      await read(fetchFn);
      for (let i = 0; i < 30; i++) {
        clock += 3_600_000;
        feeder.feed();
      }
      return readFileSync(localSheetFile(dir, refOf), 'utf8');
    };
    assert.equal(await run(), await run());
  });

  it('goes on looking after a sheet after the bot is restarted', async () => {
    const first = boot();
    await read(first.fetchFn);
    const restarted = new TestSheetFeeder(dir, () => clock, { seed: 9 });
    assert.equal(restarted.count, 0);
    restarted.adopt(refOf);
    assert.equal(restarted.count, 1);
    clock += 4 * DAY;
    assert.ok(restarted.feed().added > 0);
    restarted.adopt({ id: 'a-sheet-with-no-file-0000000', gid: null });
    assert.equal(restarted.count, 1, 'a sheet that has no file is not looked after');
  });

  it('says what it changed in the log, and nothing when nothing changed', async () => {
    const { feeder, fetchFn, lines } = boot();
    await read(fetchFn);
    lines.length = 0;
    feeder.feed(); // at the very start: nothing to add yet, nothing flown
    assert.ok(lines.length <= 1);
    clock += 2 * DAY;
    feeder.feed();
    assert.ok(lines.some((l) => /^\[test\] sheet feed: \+\d+ flights/.test(l)), lines.join(' | '));
  });
});

describe('the performance monitor', () => {
  it('times a step, says when it did something, and says how the bot is doing', async () => {
    const { log, lines } = recorder();
    const perf = new PerfMonitor(log, () => NOW, { extra: () => 'a database of 1.0 MB' });
    const quiet = perf.wrap('reminders', { run: async () => 0 });
    const busy = perf.wrap('cleanup', { run: async () => 3 });
    await quiet.run();
    await busy.run();
    await busy.run();
    await perf.time('whole pass', async () => new Promise((r) => setTimeout(r, 15)));
    assert.deepEqual(lines, ['[fired] cleanup: 3 (clock 2026-11-25T12:00Z)', '[fired] cleanup: 3 (clock 2026-11-25T12:00Z)']);
    const report = perf.report();
    assert.match(report[0]!, /^\[perf\] #1 clock 2026-11-25T12:00Z, .* min running \| thread delay p50 .* ms, p99 .* ms, worst .* ms \| heap [\d.]+ MB, memory [\d.]+ MB \| a database of 1.0 MB$/);
    assert.match(report[1]!, /^\[perf\] steps since the last report: /);
    assert.match(report[1]!, /whole pass x1 \(avg \d+(\.\d)?, max \d+(\.\d)? ms\)/);
    assert.match(report[1]!, /cleanup x2 /);
    assert.match(report[1]!, /reminders x1 /);
    assert.deepEqual(perf.report().length, 1, 'the counts start again after a report');
  });

  it('passes what a step returns, and what it throws, through unchanged', async () => {
    const { log } = recorder();
    const perf = new PerfMonitor(log, () => NOW);
    assert.equal(await perf.wrap('a', { run: async () => 'x' }).run(), 'x');
    await assert.rejects(perf.wrap('b', { run: async () => Promise.reject(new Error('boom')) }).run(), /boom/);
    assert.match(perf.report()[1]!, /a x1.*b x1|b x1.*a x1/, 'a step that failed was timed too');
  });

  it('says when a new day of the faster clock begins, and can be stopped', async () => {
    const { log, lines } = recorder();
    let virtual = NOW;
    const perf = new PerfMonitor(log, () => virtual, { everyMs: 60_000 });
    perf.start();
    virtual += DAY;
    await new Promise((r) => setTimeout(r, 1100));
    perf.stop();
    assert.ok(lines.some((l) => /^\[clock\] a new day begins: 2026-11-26 /.test(l)), lines.join(' | '));
  });
});

describe('the made-up schedule always has flights nobody signs up for', () => {
  it('leaves one flight in five (those whose number ends in 0 or 5) without a pilot, so the midnight list has something to say', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fpb-unpopular-'));
    try {
      let clock = NOW;
      const feeder = new TestSheetFeeder(dir, () => clock, { seed: 3 });
      const fetchFn = localSheetFetch(dir, (async () => { throw new Error('asked the internet'); }) as unknown as typeof fetch, undefined, feeder.make);
      await fetchFn(`https://docs.google.com/spreadsheets/d/${TEST_SHEET_ID}/export?format=csv`);
      for (let hour = 0; hour < 24 * 4; hour++) {
        clock += 3_600_000;
        feeder.feed();
      }
      const jobs = parseSheetCsv(await (await fetchFn(`https://docs.google.com/spreadsheets/d/${TEST_SHEET_ID}/export?format=csv`)).text(), clock).jobs;
      const future = jobs.filter((j) => (j.availableFrom ?? 0) > clock - 6 * 3_600_000 && !j.completed);
      const unpopular = future.filter((j) => /[05]$/.test(j.flightNumber ?? ''));
      assert.ok(unpopular.length >= 3, `${unpopular.length} flights`);
      assert.ok(unpopular.every((j) => !j.legs[0]?.heldBy), 'nobody put their name against one');
      assert.ok(future.some((j) => !/[05]$/.test(j.flightNumber ?? '') && j.legs[0]?.heldBy), 'the others do get pilots');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
