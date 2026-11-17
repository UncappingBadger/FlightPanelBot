import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FsHubError } from '../src/fshub/client.js';
import type { JobSource } from '../src/jobs/types.js';
import { AeroNumbers } from '../src/services/aeroNumbers.js';
import { AutoCompleter } from '../src/services/autoComplete.js';
import { FsHubSync } from '../src/services/fshubSync.js';
import { HOUR_MS, HourlySlot } from '../src/services/hourlySlot.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { Scheduler } from '../src/services/scheduler.js';
import { HOUR, T0, makeHarness, sj, type Harness } from './helpers.js';
import { FakeFsHub } from './discord-helpers.js';

const MIN = 60_000;
const AIRLINE = 4242;
const SHEET = 'sheet-id';

describe('the hourly slot', () => {
  const slot = new HourlySlot(23);
  const at = (hour: number, minute = 0, second = 0) => Date.UTC(2026, 10, 11, hour, minute, second);

  it('begins at the same minute of every hour (UTC), and the next one an hour on', () => {
    assert.equal(slot.start(at(14, 23)), at(14, 23));
    assert.equal(slot.start(at(14, 59, 59)), at(14, 23));
    assert.equal(slot.start(at(15, 22, 59)), at(14, 23));
    assert.equal(slot.start(at(15, 23)), at(15, 23));
    assert.equal(slot.start(at(0, 5)), at(23, 23) - 24 * HOUR_MS, 'across midnight');
    assert.equal(slot.next(at(14, 40)), at(15, 23));
    assert.equal(new HourlySlot(0).start(at(14, 59)), at(14, 0));
  });

  it('says something is due when it has not been done since the slot began', () => {
    assert.equal(slot.due(null, at(14, 30)), true, 'never done');
    assert.equal(slot.due(at(14, 23), at(14, 59)), false, 'done at the start of this slot');
    assert.equal(slot.due(at(14, 40), at(15, 10)), false, 'done mid-slot, still the same slot at 15:10');
    assert.equal(slot.due(at(14, 40), at(15, 23)), true, 'the next slot has begun');
    assert.equal(slot.due(at(14, 22, 59), at(14, 23)), true, 'done a moment before the slot began');
    assert.equal(slot.due(at(10, 0), at(14, 30)), true, 'missed while the bot was off');
  });

  it('counts whole slots between two moments', () => {
    assert.equal(slot.slotsSince(at(8, 30), at(14, 24)), 6);
    assert.equal(slot.slotsSince(at(8, 30), at(14, 22)), 5);
    assert.equal(slot.slotsSince(at(14, 30), at(14, 50)), 0);
  });

  it('ignores a minute that is not one, and keeps the minute it is given', () => {
    assert.equal(new HourlySlot(60).minute, 0);
    assert.equal(new HourlySlot(-3).minute, 0);
    assert.equal(new HourlySlot(2.5).minute, 0);
    assert.equal(new HourlySlot(41).minute, 41);
  });

  describe('for an install', () => {
    const fakeStore = (initial: string | null = null) => {
      const kv = new Map<string, string>(initial === null ? [] : [['hourly.minute', initial]]);
      return { kv, getKv: (k: string) => kv.get(k) ?? null, setKv: (k: string, v: string) => void kv.set(k, v) };
    };

    it('picks a minute the first time, saves it, and uses the same one ever after', () => {
      const store = fakeStore();
      assert.equal(HourlySlot.forInstall(store, () => 37).minute, 37);
      assert.equal(store.kv.get('hourly.minute'), '37');
      assert.equal(HourlySlot.forInstall(store, () => 5).minute, 37, 'not picked again');
    });

    it('picks again when what was saved is not a minute', () => {
      for (const bad of ['', 'abc', '60', '-1', '2.5']) {
        const store = fakeStore(bad);
        assert.equal(HourlySlot.forInstall(store, () => 12).minute, 12, bad);
        assert.equal(store.kv.get('hourly.minute'), '12');
      }
      assert.equal(HourlySlot.forInstall(fakeStore('0'), () => 12).minute, 0, 'the top of the hour is a minute too');
    });

    it('picks, by itself, a minute that is neither the very start nor the very end of the hour', () => {
      for (let i = 0; i < 300; i++) {
        const minute = HourlySlot.forInstall(fakeStore()).minute;
        assert.ok(minute >= 3 && minute <= 56, String(minute));
      }
    });
  });
});

/* ------------------------------------------------------------------ all the hourly checks together */

describe('the hourly checks happen together', () => {
  let h: Harness;
  let slot: HourlySlot;
  let reads: number;
  let failSheet: boolean;
  let fshub: FakeFsHub;
  let contractCalls: number;
  let refresher: SourceRefresher;
  let sync: FsHubSync;
  let ac: AutoCompleter;
  let numbers: AeroNumbers;
  let scheduler: Scheduler;
  let boundary: number;
  const pid = () => h.panel.id;
  const panel = () => h.store.getPanel(pid())!;
  const source: JobSource = {
    kind: 'test',
    fetch: async () => {
      reads++;
      if (failSheet) throw new Error('sheet down');
      return [sj('a', 'EGLL-EGKK', { availableFrom: boundary - HOUR, deadline: boundary + 5 * HOUR })];
    },
  };
  const counts = () => ({ sheet: reads, roster: fshub.rosterCalls.length, complete: panel().fshubAutoCompleteAt, aeroconomy: contractCalls });
  /** One scheduler pass at `now`, with everything it starts in the background finished. */
  const pass = async (now: number) => {
    h.clock.now = now;
    await scheduler.tick();
    await scheduler.idle();
    await numbers.idle();
    return counts();
  };

  beforeEach(async () => {
    h = await makeHarness();
    slot = new HourlySlot(23);
    boundary = Date.UTC(2026, 10, 11, 18, 23); // a slot begins here
    h.clock.now = boundary - 5 * MIN;
    reads = 0;
    contractCalls = 0;
    failSheet = false;
    fshub = new FakeFsHub();
    const now = () => h.clock.now;
    refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, now, (p, jobs) => numbers.enrich(p, jobs), slot);
    sync = new FsHubSync(h.store, fshub, { schedule: () => undefined }, { now, slot });
    ac = new AutoCompleter({ store: h.store, jobs: h.jobs, sync, writeback: null, now, slot });
    numbers = new AeroNumbers({
      store: h.store,
      client: {
        airlineContracts: async () => (contractCalls++, []),
        manifests: async () => [],
      },
      now,
      slot,
    });
    h.store.updatePanel(pid(), { sheetId: SHEET, sheetGid: '1', fshubAirlineId: AIRLINE, flightNumbers: true });
    scheduler = new Scheduler(h.jobs, refresher, { fshub: sync, autoComplete: ac, numbers });
  });
  afterEach(async () => {
    await scheduler.idle();
    await numbers.idle();
    await h.close();
  });

  /** Every check last ran at a different moment of the previous slot (so an hour after each would be a different time for each). */
  const stagger = () => {
    h.store.updatePanel(pid(), { lastRefreshAt: boundary - 50 * MIN, fshubSyncedAt: boundary - 20 * MIN, fshubAutoCompleteAt: boundary - 35 * MIN });
    h.store.setKv(`aeronum.${AIRLINE}`, JSON.stringify({ at: boundary - 6 * HOUR + 40 * MIN, contracts: 0, flights: [] }));
  };

  it('do nothing before the slot begins, however long ago each last ran', async () => {
    stagger();
    const before = counts();
    assert.deepEqual(await pass(boundary - MIN), before);
  });

  it('all run in the very same pass when it begins, the sheet, the FsHub roster, the completing of flown flights and (every sixth slot) Aeroconomy', async () => {
    stagger();
    const before = counts();
    const after = await pass(boundary);
    assert.deepEqual({ sheet: after.sheet - before.sheet, roster: after.roster - before.roster, aeroconomy: after.aeroconomy - before.aeroconomy }, { sheet: 1, roster: 1, aeroconomy: 1 });
    assert.equal(after.complete, boundary, 'the completing ran too');
  });

  it('then leave each other alone until the next slot, and run again together in it', async () => {
    stagger();
    await pass(boundary);
    const first = counts();
    assert.deepEqual(await pass(boundary + 1 * MIN), first);
    assert.deepEqual(await pass(boundary + 30 * MIN), first);
    assert.deepEqual(await pass(boundary + HOUR - MIN), first);
    const next = await pass(boundary + HOUR);
    assert.deepEqual({ sheet: next.sheet - first.sheet, roster: next.roster - first.roster, aeroconomy: next.aeroconomy - first.aeroconomy }, { sheet: 1, roster: 1, aeroconomy: 0 }, 'Aeroconomy only every sixth');
    assert.equal(next.complete, boundary + HOUR);
    const sixth = await pass(boundary + 6 * HOUR);
    assert.equal(sixth.aeroconomy, first.aeroconomy + 1);
  });

  it('a read somebody asked for in the middle of the slot does not make it run twice, nor move the next one', async () => {
    stagger();
    await pass(boundary);
    h.clock.now = boundary + 20 * MIN;
    await refresher.refresh(panel()); // `/setup refresh`
    const asked = counts();
    assert.equal(asked.sheet, 2);
    assert.deepEqual(await pass(boundary + 40 * MIN), asked);
    assert.equal((await pass(boundary + HOUR)).sheet, 3, 'and the next slot reads it as usual');
  });

  it('after a restart, do what a slot they missed asks at once, and nothing for a slot they have already done', async () => {
    await pass(boundary); // ran in this slot, then the bot restarted
    refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, () => h.clock.now, undefined, slot);
    scheduler = new Scheduler(h.jobs, refresher, { fshub: new FsHubSync(h.store, fshub, { schedule: () => undefined }, { now: () => h.clock.now, slot }) });
    const done = counts();
    assert.deepEqual(await pass(boundary + 25 * MIN), done, 'same slot: nothing');
    // The bot is off across the next boundary and starts again 20 minutes into the slot after it.
    assert.equal((await pass(boundary + HOUR + 20 * MIN)).sheet, done.sheet + 1, 'a missed slot is done on return');
  });

  describe('when something fails', () => {
    it('a sheet that cannot be read is tried once in the slot, and again in the next, not every minute', async () => {
      failSheet = true;
      await pass(boundary);
      assert.equal(reads, 1);
      await pass(boundary + MIN);
      await pass(boundary + 30 * MIN);
      assert.equal(reads, 1, 'not again in this slot');
      failSheet = false;
      await pass(boundary + HOUR);
      assert.equal(reads, 2);
      assert.equal(panel().lastRefreshError, null);
    });

    it('a roster FsHub cannot give for now is tried again in ten minutes, not every minute, and then waits for the next slot', async () => {
      fshub.rosterError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
      await pass(boundary);
      assert.equal(fshub.rosterCalls.length, 1);
      await pass(boundary + 9 * MIN);
      assert.equal(fshub.rosterCalls.length, 1, 'not yet');
      fshub.rosterError = null;
      await pass(boundary + 10 * MIN);
      assert.equal(fshub.rosterCalls.length, 2, 'ten minutes on');
      assert.equal(panel().fshubSyncedAt, boundary + 10 * MIN);
      await pass(boundary + 30 * MIN);
      assert.equal(fshub.rosterCalls.length, 2, 'done for this slot');
      await pass(boundary + HOUR);
      assert.equal(fshub.rosterCalls.length, 3);
    });

    it('a roster FsHub refuses for good counts as this slot\'s read, and is tried in the next', async () => {
      fshub.rosterError = new FsHubError('rejected', 'FsHub did not accept the token.');
      await pass(boundary);
      await pass(boundary + 10 * MIN);
      await pass(boundary + 30 * MIN);
      assert.equal(fshub.rosterCalls.length, 1);
      await pass(boundary + HOUR);
      assert.equal(fshub.rosterCalls.length, 2);
    });
  });
});
