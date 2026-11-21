import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import type { AeroContract, AeroFlight } from '../src/aeroconomy/client.js';
import { AeroNumbers } from '../src/services/aeroNumbers.js';
import type { Logger } from '../src/util/log.js';
import { CHANNEL, makeHarness, sj, T0, type Harness } from './helpers.js';
import { makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

describe('stopping the bot', () => {
  describe('the database', () => {
    it('knows it has been closed, so work still under way can put its result down quietly', () => {
      const store = new Store(openDatabase(':memory:'));
      assert.equal(store.isClosed, false);
      store.close();
      assert.equal(store.isClosed, true);
      assert.throws(() => store.listAllPanels(), /not open/);
      assert.doesNotThrow(() => store.close(), 'closing it again (a shutdown asked for twice) is harmless');
    });
  });

  describe('the panels', () => {
    let h: Harness;
    let d: DiscordHarness;
    beforeEach(async () => {
      h = await makeHarness();
      d = makeDiscordHarness(h);
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    });
    afterEach(async () => {
      await settle(40);
      await h.close();
    });

    it('draw as usual until stopped', async () => {
      assert.equal(await d.panels.refresh(h.panel.id), 'posted');
      assert.ok(d.client.channel(CHANNEL).live.length > 0);
    });

    it('draw nothing once stopped: a request made then, or a redraw that was waiting, is dropped', async () => {
      d.panels.schedule(h.panel.id); // asked for, not yet drawn
      d.panels.stop();
      await settle(120); // past the debounce
      assert.equal(d.client.channel(CHANNEL).live.length, 0, 'the one that was waiting is dropped');
      assert.equal(await d.panels.refresh(h.panel.id), 'skipped');
      assert.equal(await d.panels.refresh(h.panel.id, { force: true }), 'skipped');
      d.panels.schedule(h.panel.id);
      await settle(120);
      assert.equal(d.client.channel(CHANNEL).live.length, 0, 'and so is a new one');
    });

    it('can be waited for, so a redraw under way finishes before the database is closed', async () => {
      const drawing = d.panels.refresh(h.panel.id);
      await d.panels.drain(2000);
      assert.equal(await drawing, 'posted');
      assert.ok(d.client.channel(CHANNEL).live.length > 0, 'it finished');
      await d.panels.drain(50); // nothing under way: returns at once
    });

    it('does not wait longer than it is told for a redraw that never finishes', async () => {
      d.client.channel(CHANNEL).hang = true;
      void d.panels.refresh(h.panel.id).catch(() => undefined);
      const t0 = Date.now();
      await d.panels.drain(120);
      assert.ok(Date.now() - t0 < 1500, 'gave up after the time it was given');
      d.client.channel(CHANNEL).hang = false;
    });
  });

  describe('the slow read of Aeroconomy\'s flight numbers', () => {
    const AIRLINE = 4242;
    let h: Harness;
    let reads: string[];
    let warnings: string[];
    let applied: number[];
    let release: () => void;
    let gate: Promise<void>;
    const log: Logger = { debug() {}, info() {}, warn: (m: string) => void warnings.push(String(m)), error: (m: string) => void warnings.push(String(m)) } as unknown as Logger;
    const contracts: AeroContract[] = [
      { id: 7, status: 'active', total: 3 },
      { id: 8, status: 'active', total: 3 },
    ];
    const flights: AeroFlight[] = [{ number: 'TST290', dep: 'EGLL', arr: 'EGKK', start: T0, end: T0 + 6 * 3_600_000, status: '' }];
    const client = {
      async airlineContracts() {
        reads.push('contracts');
        await gate;
        return contracts;
      },
      async manifests(id: number) {
        reads.push(`manifests:${id}`);
        return flights;
      },
    };
    let numbers: AeroNumbers;

    beforeEach(async () => {
      h = await makeHarness();
      h.clock.now = T0;
      reads = [];
      warnings = [];
      applied = [];
      gate = new Promise<void>((r) => (release = r));
      h.store.updatePanel(h.panel.id, { flightNumbers: true, fshubAirlineId: AIRLINE });
      numbers = new AeroNumbers({ store: h.store, client, apply: async (p) => void applied.push(p.id), logger: log, now: () => h.clock.now });
    });
    afterEach(async () => {
      release?.();
      await numbers.idle();
      await h.close();
    });

    it('stops at its next step when the bot is shutting down: it reads nothing more, writes nothing, and does not warn', async () => {
      await numbers.run(); // started, waiting on the first request
      numbers.stop();
      release();
      await numbers.idle();
      assert.deepEqual(reads, ['contracts'], 'no contract was read after it was stopped');
      assert.equal(numbers.cacheFor(AIRLINE), null, 'nothing was saved');
      assert.deepEqual(applied, [], 'and nothing applied to a panel');
      assert.deepEqual(warnings, [], 'and nothing was reported as having gone wrong');
    });

    it('starts no new read once stopped', async () => {
      numbers.stop();
      await numbers.run();
      assert.deepEqual(reads, []);
    });

    it('does not report the database being closed as a failure of the read', async () => {
      await numbers.run();
      numbers.stop();
      h.store.close(); // the shutdown went ahead while the read was waiting
      release();
      await numbers.idle();
      assert.deepEqual(warnings, []);
      // (the harness closes the store again afterwards, which is harmless)
    });

    it('reads as usual when it is not stopped', async () => {
      release();
      await numbers.run();
      await numbers.idle();
      assert.deepEqual(reads, ['contracts', 'manifests:7', 'manifests:8']);
      assert.ok(numbers.cacheFor(AIRLINE));
      assert.deepEqual(warnings, []);
    });
  });
});
