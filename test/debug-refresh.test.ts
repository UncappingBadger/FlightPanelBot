import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

/*
 * The diagnostic build reads a linked sheet every two minutes instead of once an hour. That switch is fixed when the program starts, so this file
 * turns it on BEFORE anything of the bot's is loaded (everything is imported inside `before`), in a process of its own (each test file is one).
 */

const MIN = 60_000;
/* eslint-disable @typescript-eslint/no-explicit-any */
let debugOn: boolean;
let DEBUG_SHEET_INTERVAL_MS: number;
let SourceRefresher: any;
let makeHarness: any;
let sj: any;
let T0: number;

before(async () => {
  (globalThis as any).__FPB_DEBUG__ = true;
  debugOn = (await import('../src/util/debugBuild.js')).DEBUG_BUILD;
  ({ DEBUG_SHEET_INTERVAL_MS, SourceRefresher } = await import('../src/services/refresh.js'));
  ({ makeHarness, sj, T0 } = await import('./helpers.js'));
});
after(() => {
  delete (globalThis as any).__FPB_DEBUG__;
});

describe('the diagnostic build reads a linked sheet every two minutes', () => {
  let h: any;
  let reads: number;
  let fail: boolean;
  let refresher: any;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const source = {
    kind: 'test',
    fetch: async () => {
      reads++;
      if (fail) throw new Error('sheet down');
      return [sj('a', 'EGLL-EGKK', { availableFrom: T0 - 3_600_000, deadline: T0 + 5 * 3_600_000 })];
    },
  };
  const at = async (minutes: number) => {
    h.clock.now = T0 + minutes * MIN;
    return refresher.refreshDue();
  };

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    reads = 0;
    fail = false;
    h.store.updatePanel(h.panel.id, { sheetId: 'SheetQuick', sheetGid: '1' });
    refresher = new SourceRefresher(h.store, h.jobs, () => source, undefined, () => h.clock.now);
  });

  it('really is the diagnostic build for this test, and the interval is two minutes', () => {
    assert.equal(debugOn, true);
    assert.equal(DEBUG_SHEET_INTERVAL_MS, 2 * MIN);
  });

  it('reads at once the first time, and then not again until two minutes have passed', async () => {
    assert.equal(await at(0), 1);
    assert.equal(reads, 1);
    await at(1);
    await at(1.9);
    assert.equal(reads, 1, 'not yet');
    assert.equal(await at(2), 1);
    assert.equal(reads, 2, 'two minutes after the last read');
    await at(3.5);
    assert.equal(reads, 2);
    await at(4);
    assert.equal(reads, 3);
  });

  it('reads many times within one clock hour, which the hourly slot would not', async () => {
    for (let m = 0; m <= 30; m++) await at(m);
    assert.equal(reads, 16, 'minute 0, 2, 4, ... 30');
  });

  it('waits two minutes after a read that failed, and then tries again, not an hour', async () => {
    await at(0);
    fail = true;
    await at(2);
    assert.equal(reads, 2, 'the failing read happened');
    await at(3);
    assert.equal(reads, 2, 'still cooling off');
    await at(3.9);
    assert.equal(reads, 2);
    fail = false;
    await at(4);
    assert.equal(reads, 3, 'two minutes after the failed one');
    assert.equal(panel().lastRefreshError, null);
  });

  it('leaves a panel that has no sheet on its own 24 hour rhythm', async () => {
    h.store.updatePanel(h.panel.id, { sheetId: null, sheetGid: null });
    await at(0);
    await at(2);
    await at(30);
    await at(120);
    assert.equal(reads, 1);
    await at(24 * 60 + 1);
    assert.equal(reads, 2);
  });
});
