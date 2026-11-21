import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { LiveFeed, LiveFeedError } from '../src/fshub/liveFeed.js';
import { CHANNEL, makeHarness, sj, T0, type Harness } from './helpers.js';
import { makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flightOf = (id: string, callsign: string) => ({
  id,
  phase: 'cruise',
  position: { on_ground: false },
  pilot: { id: 7001 },
  plan: { callsign, flight_no: callsign, departure: 'EGLL', arrival: 'EGKK' },
  eta_minutes: 30,
});

describe('the airline feed is read once for everything that asks', () => {
  let calls: string[];
  let reply: (url: string) => Response | Promise<Response>;
  let clock: number;
  let feed: LiveFeed;
  const make = (airlineCacheMs?: number) =>
    new LiveFeed({
      fetchFn: (async (input: unknown) => (calls.push(String(input)), reply(String(input)))) as typeof fetch,
      now: () => clock,
      ...(airlineCacheMs !== undefined ? { airlineCacheMs } : {}),
    });
  beforeEach(() => {
    calls = [];
    clock = 1_000_000;
    reply = () => json({ flights: [flightOf('a', 'TST1')] });
    feed = make();
  });

  it('answers a second caller from the first read, so the landing estimates, /monitor and a new monitor ask FsHub once', async () => {
    const first = await feed.airlineFlights('TST');
    clock += 10_000;
    const second = await feed.airlineFlights('tst');
    assert.equal(calls.length, 1);
    assert.deepEqual(second, first);
    assert.equal(first[0]!.callsign, 'TST1');
  });

  it('asks again once it is a little old, so the estimates still move by the minute', async () => {
    await feed.airlineFlights('TST');
    clock += 21_000;
    reply = () => json({ flights: [flightOf('a', 'TST1'), flightOf('b', 'TST2')] });
    assert.equal((await feed.airlineFlights('TST')).length, 2);
    assert.equal(calls.length, 2);
  });

  it('lets callers that come while a read is waiting share it, rather than each asking', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    reply = async () => {
      await gate;
      return json({ flights: [flightOf('a', 'TST1')] });
    };
    const all = Promise.all([feed.airlineFlights('TST'), feed.airlineFlights('TST'), feed.airlineFlights('TST')]);
    await settle(10);
    release();
    const [x, y, z] = await all;
    assert.equal(calls.length, 1, 'one request');
    assert.deepEqual([x, y, z].map((f) => f!.length), [1, 1, 1]);
  });

  it('keeps each airline apart', async () => {
    await feed.airlineFlights('TST');
    await feed.airlineFlights('SKY');
    assert.deepEqual(calls.map((c) => c.split('/').pop()), ['TST', 'SKY']);
  });

  it('does not remember a failure: the next caller asks again, and a failure is told to everyone who was waiting on it', async () => {
    reply = () => json({}, 500);
    await assert.rejects(feed.airlineFlights('TST'), (e: unknown) => e instanceof LiveFeedError);
    reply = () => json({ flights: [flightOf('a', 'TST1')] });
    assert.equal((await feed.airlineFlights('TST')).length, 1);
    assert.equal(calls.length, 2);
  });

  it('does not keep serving an old read after a later one fails', async () => {
    await feed.airlineFlights('TST');
    clock += 30_000;
    reply = () => json({}, 500);
    await assert.rejects(feed.airlineFlights('TST'));
    reply = () => json({ flights: [] });
    assert.deepEqual(await feed.airlineFlights('TST'), [], 'it asked again, and does not hand back the flights from before');
    assert.equal(calls.length, 3);
  });

  it('remembers that an airline the feed does not know has nothing flying, too', async () => {
    reply = () => json({}, 404);
    assert.deepEqual(await feed.airlineFlights('TST'), []);
    assert.deepEqual(await feed.airlineFlights('TST'), []);
    assert.equal(calls.length, 1);
  });

  it('asks every time when the sharing is switched off', async () => {
    feed = make(0);
    await feed.airlineFlights('TST');
    await feed.airlineFlights('TST');
    assert.equal(calls.length, 2);
  });
});

describe('the database keeps the statements it has prepared', () => {
  it('gives the right answers when the same query is asked again after the data changed', async () => {
    const h = await makeHarness();
    try {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      assert.equal(h.store.listOpenJobViews(h.panel.id).length, 1);
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('b', 'EGKK-EGCC'), sj('c', 'EGCC-EGPH')]);
      assert.equal(h.store.listOpenJobViews(h.panel.id).length, 3, 'a statement used before still sees what was written since');
      h.jobs.sync(h.panel.id, []);
      assert.equal(h.store.listOpenJobViews(h.panel.id).length, 0);
    } finally {
      await h.close();
    }
  });

  it('cannot be made to hold an unbounded number: far more different queries than the limit still work', () => {
    const store = new Store(openDatabase(':memory:'));
    const internal = store as unknown as { stmt(sql: string): { get(): Record<string, unknown> }; statements: Map<string, unknown> };
    for (let i = 0; i < 1200; i++) assert.equal(Object.values(internal.stmt(`SELECT ${i} AS n`).get())[0], i);
    assert.ok(internal.statements.size <= 400, `${internal.statements.size} kept`);
    assert.equal(store.listAllPanels().length, 0, 'and an ordinary query is fine afterwards');
    store.close();
  });

  it('lets go of them when it is closed', () => {
    const store = new Store(openDatabase(':memory:'));
    store.listAllPanels();
    const internal = store as unknown as { statements: Map<string, unknown> };
    assert.ok(internal.statements.size > 0);
    store.close();
    assert.equal(internal.statements.size, 0);
  });
});

describe('the panel looks for its messages all at once', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    h.jobs.sync(h.panel.id, Array.from({ length: 40 }, (_, i) => sj(`f${i}`, 'EGLL-EGKK')));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('asks Discord about every message of the panel together, so a redraw takes about one round trip rather than one for each', async () => {
    assert.equal(await d.panels.refresh(h.panel.id), 'posted');
    const messages = d.client.channel(CHANNEL).live.length;
    assert.ok(messages >= 3, `${messages} messages`);

    const channel = d.client.channel(CHANNEL);
    const original = channel.messages.fetch;
    let inFlight = 0;
    let most = 0;
    channel.messages.fetch = async (arg) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await settle(5); // Discord takes a moment to answer
      try {
        return await original(arg);
      } finally {
        inFlight--;
      }
    };
    h.jobs.sync(h.panel.id, Array.from({ length: 40 }, (_, i) => sj(`f${i}`, 'EGLL-EGKK', { notes: 'changed' })));
    assert.equal(await d.panels.refresh(h.panel.id), 'updated');
    assert.equal(most, messages, 'all of them were being asked about at the same time');
    channel.messages.fetch = original;
  });

  it('still notices a message someone deleted, and puts the panel back in order', async () => {
    await d.panels.refresh(h.panel.id);
    const channel = d.client.channel(CHANNEL);
    const before = channel.live.length;
    channel.deleteMessage(channel.live[1]!.id);
    h.jobs.sync(h.panel.id, Array.from({ length: 40 }, (_, i) => sj(`f${i}`, 'EGLL-EGKK', { notes: 'x' })));
    assert.equal(await d.panels.refresh(h.panel.id), 'posted');
    assert.equal(channel.live.length, before);
  });
});
