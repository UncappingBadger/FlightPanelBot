import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DemoJobSource } from '../src/jobs/demo.js';
import type { JobSource, SourceJob } from '../src/jobs/types.js';
import { JobError } from '../src/services/jobs.js';
import { REFRESH_INTERVAL_MS, SourceRefresher } from '../src/services/refresh.js';
import { Scheduler } from '../src/services/scheduler.js';
import { silentLogger } from '../src/util/log.js';
import { AIRLINE, HOUR, makeHarness, sj, T0, USER_A, type Harness } from './helpers.js';

const DAY = 24 * HOUR;

describe('DemoJobSource', () => {
  const source = new DemoJobSource();

  it('produces multi-leg and single-leg flights with airframes and future deadlines', async () => {
    const jobs = await source.fetch(AIRLINE, T0);
    assert.ok(jobs.length >= 6);
    assert.ok(jobs.some((j) => j.legs.length === 1) && jobs.some((j) => j.legs.length >= 3));
    assert.ok(jobs.every((j) => j.aircraft && j.deadline! > T0));
    assert.equal(new Set(jobs.map((j) => j.key)).size, jobs.length, 'keys are unique');
  });

  it('gives the same keys when asked again the same day, so IDs do not change', async () => {
    const a = await source.fetch(AIRLINE, T0);
    const b = await source.fetch(AIRLINE, T0 + 3 * HOUR);
    assert.ok(b.every((j) => a.some((x) => x.key === j.key)));
  });

  it('brings a new batch the next day while yesterday\'s live flights stay', async () => {
    const day1 = await source.fetch(AIRLINE, T0);
    const day2 = await source.fetch(AIRLINE, T0 + DAY);
    const fresh = day2.filter((j) => !day1.some((x) => x.key === j.key));
    const kept = day2.filter((j) => day1.some((x) => x.key === j.key));
    assert.ok(fresh.length > 0, 'new flights arrive');
    assert.ok(kept.length > 0, 'some of yesterday\'s are still live');
  });
});

describe('SourceRefresher', () => {
  let h: Harness;
  let calls: number;
  let next: () => Promise<SourceJob[]>;
  let refresher: SourceRefresher;
  const source: JobSource = {
    kind: 'test',
    fetch: async () => {
      calls++;
      return next();
    },
  };

  beforeEach(async () => {
    h = await makeHarness();
    calls = 0;
    next = async () => [sj('a', 'EGLL-EGKK'), sj('b', 'EGLL-EGCC-EGPH')];
    refresher = new SourceRefresher(h.store, h.jobs, () => source, silentLogger, () => h.clock.now);
  });
  afterEach(() => h.close());

  it('fetches, applies the jobs and stamps the refresh time', async () => {
    const r = await refresher.refresh(h.panel);
    assert.equal(r.added, 2);
    assert.equal(h.store.getPanel(h.panel.id)!.lastRefreshAt, T0);
    assert.equal(h.store.getPanel(h.panel.id)!.lastRefreshError, null);
  });

  it('refreshes only panels whose last refresh is over 24 hours old', async () => {
    assert.equal(await refresher.refreshDue(), 1, 'never refreshed, so due');
    assert.equal(await refresher.refreshDue(), 0, 'just done');
    h.clock.advance(REFRESH_INTERVAL_MS - 1000);
    assert.equal(await refresher.refreshDue(), 0);
    h.clock.advance(2000);
    assert.equal(await refresher.refreshDue(), 1);
    assert.equal(calls, 2);
  });

  it('applies changes between refreshes: new jobs appear, gone ones close, reservations survive', async () => {
    await refresher.refresh(h.panel);
    const a = h.jobs.open(h.panel.id)[0]!.job.id;
    h.jobs.reserve(a, [1], USER_A);
    next = async () => [sj('a', 'EGLL-EGKK'), sj('c', 'EGKK-EGCC')]; // b gone, c new
    h.clock.advance(DAY);
    await refresher.refreshDue();
    assert.deepEqual(h.jobs.open(h.panel.id).map((v) => v.job.code), ['TST-001', 'TST-003']);
    assert.equal(h.jobs.view(a)!.legs[0]!.holder?.username, 'alice');
  });

  it('on failure keeps the existing flights, records the error and retries no sooner than an hour', async () => {
    await refresher.refresh(h.panel);
    h.clock.advance(DAY);
    next = async () => {
      throw new Error('upstream is down');
    };
    assert.equal(await refresher.refreshDue(), 0);
    assert.equal(h.jobs.open(h.panel.id).length, 2, 'flights untouched');
    assert.match(h.store.getPanel(h.panel.id)!.lastRefreshError!, /upstream is down/);
    assert.equal(calls, 2);

    await refresher.refreshDue();
    assert.equal(calls, 2, 'no retry yet');
    h.clock.advance(61 * 60_000);
    next = async () => [sj('a', 'EGLL-EGKK')];
    assert.equal(await refresher.refreshDue(), 1);
    assert.equal(h.store.getPanel(h.panel.id)!.lastRefreshError, null, 'error cleared on success');
  });

  it('skips panels with no automatic source, and says so if asked to refresh one', async () => {
    const none = new SourceRefresher(h.store, h.jobs, () => null, silentLogger, () => h.clock.now);
    assert.equal(none.hasSource(h.panel), false);
    assert.equal(await none.refreshDue(), 0);
    await assert.rejects(none.refresh(h.panel), (e: unknown) => e instanceof JobError && /\/setup import/.test(e.message));
  });
});

describe('Scheduler', () => {
  let h: Harness;
  let refresher: SourceRefresher;
  let scheduler: Scheduler;
  let fetches: number;

  beforeEach(async () => {
    h = await makeHarness();
    fetches = 0;
    const source: JobSource = {
      kind: 'test',
      fetch: async () => {
        fetches++;
        return [sj('soon', 'EGLL-EGKK', { deadline: h.clock.now + 2 * HOUR }), sj('later', 'EGLL-EGCC', { deadline: h.clock.now + 40 * HOUR })];
      },
    };
    refresher = new SourceRefresher(h.store, h.jobs, () => source, silentLogger, () => h.clock.now);
    scheduler = new Scheduler(h.jobs, refresher);
  });
  afterEach(() => h.close());

  it('refreshes from the source on the first tick and then only once every 24 hours', async () => {
    await scheduler.tick();
    assert.equal(fetches, 1);
    h.clock.advance(3 * HOUR);
    await scheduler.tick();
    assert.equal(fetches, 1, 'not due yet');
    h.clock.advance(DAY);
    await scheduler.tick();
    assert.equal(fetches, 2);
  });

  it('closes flights at their deadline on each tick, and redraws the panel', async () => {
    await scheduler.tick();
    assert.equal(h.jobs.open(h.panel.id).length, 2);
    h.emitted.length = 0;
    h.clock.advance(3 * HOUR);
    await scheduler.tick();
    assert.deepEqual(h.jobs.open(h.panel.id).map((v) => v.job.code), ['TST-002']);
    assert.ok(h.emitted.some((e) => e.type === 'changed'));
  });

  it('a flight that has passed its deadline is not brought back by a refresh', async () => {
    await scheduler.tick();
    h.clock.advance(3 * HOUR);
    await scheduler.tick();
    assert.equal(h.jobs.open(h.panel.id).length, 1);
  });

  it('keeps going when the source fails', async () => {
    const failing = new SourceRefresher(h.store, h.jobs, () => ({ kind: 'bad', fetch: async () => Promise.reject(new Error('boom')) }), silentLogger, () => h.clock.now);
    const s = new Scheduler(h.jobs, failing);
    await assert.doesNotReject(s.tick());
  });

  it('skips a tick that overlaps a still-running one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = refresher.refreshDue.bind(refresher);
    refresher.refreshDue = async () => {
      await gate;
      return slow();
    };
    const first = scheduler.tick();
    await scheduler.tick(); // returns at once: the first is still running
    release();
    await first;
    assert.equal(fetches, 1);
  });

  it('start and stop manage the timer idempotently', () => {
    const s = new Scheduler(h.jobs, refresher, { tickMs: 1_000_000 });
    s.start();
    s.start();
    s.stop();
    s.stop();
  });
});
