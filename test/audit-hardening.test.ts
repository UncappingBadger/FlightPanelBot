import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setupCommand } from '../src/discord/commands/setup.js';
import { lookUpMessages } from '../src/discord/panel.js';
import { noteIfSlow, whileTyping } from '../src/discord/router.js';
import { SheetsApi, SheetsError, type Cell, type SheetsPort } from '../src/google/sheetsApi.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import type { SheetRef } from '../src/jobs/sheet.js';
import { Scheduler } from '../src/services/scheduler.js';
import { SheetWriteBack } from '../src/services/writeback.js';
import type { Logger } from '../src/util/log.js';
import { CHANNEL, GUILD, makeHarness, sj, T0, type Harness } from './helpers.js';
import { fakeInteraction, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID, scheduleGrid } from './fake-google.js';

const NOW = T0; // 2026-11-11 12:00Z, the day the shared sample sheet is set on

/** A logger that keeps what it is told, by level. */
function recorder() {
  const lines: string[] = [];
  const log: Logger = { debug() {}, info: (m: string) => void lines.push(`info ${m}`), warn: (m: string) => void lines.push(`warn ${m}`), error: (m: string) => void lines.push(`error ${m}`) } as unknown as Logger;
  return { log, lines };
}

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
};

/* ------------------------------------------------------------------ the sheet's write queue */

describe('writes to the airline sheets', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  /** A pretend Google that holds the reads of the sheets named in `held` until they are let go, and says what was read, in order. */
  function holdingApi(held: Map<string, Promise<void>>, log: string[]): SheetsPort {
    return {
      tabTitle: async () => 'Tab',
      readTab: async (ref: SheetRef) => {
        log.push(`read ${ref.id}`);
        await held.get(ref.id);
        log.push(`got ${ref.id}`);
        return { title: 'Tab', values: scheduleGrid() };
      },
      columnNumberFormats: async () => ({ sheetId: 0, types: new Map() }),
      setNumberFormat: async () => undefined,
      update: async (ref: SheetRef, _title: string, cells: Cell[]) => void log.push(`wrote ${ref.id} ${cells.map((c) => c.a1).join(',')}`),
    };
  }
  const panelOn = (sheetId: string, name: string) => {
    const p = h.store.createPanel({ guildId: GUILD, name, prefix: name.slice(0, 3).toUpperCase(), channelId: CHANNEL, now: NOW });
    h.store.updatePanel(p.id, { sheetId, sheetGid: '1', writeback: true });
    return h.store.getPanel(p.id)!;
  };
  const KEY = 'EGLL-EGCC@2026-11-12';

  it('go in a line for each sheet: a pilot of one airline never waits behind another airline\'s write', async () => {
    const held = new Map([['sheet-A', gate()]]);
    const log: string[] = [];
    const wb = new SheetWriteBack(holdingApi(new Map([['sheet-A', held.get('sheet-A')!.opened]]), log), 'bot@example.com', { now: () => NOW });
    const a = panelOn('sheet-A', 'Alpha Air');
    const b = panelOn('sheet-B', 'Beta Air');

    const slow = wb.claim(a, KEY, 'Alice'); // sheet A is slow to answer
    await settle(20);
    await wb.claim(b, KEY, 'Bob'); // sheet B does not wait for it
    assert.ok(log.includes('wrote sheet-B E3'), log.join(' | '));
    assert.ok(!log.some((l) => l.startsWith('wrote sheet-A')), 'sheet A is still waiting');
    held.get('sheet-A')!.open();
    await slow;
    assert.ok(log.includes('wrote sheet-A E3'));
  });

  it('still go one at a time within one sheet, in the order they were asked', async () => {
    const g = gate();
    const log: string[] = [];
    const wb = new SheetWriteBack(holdingApi(new Map([['sheet-A', g.opened]]), log), 'bot@example.com', { now: () => NOW });
    const a = panelOn('sheet-A', 'Alpha Air');
    const first = wb.claim(a, KEY, 'Alice');
    const second = wb.claim(a, 'EGLL-EGPH@2026-11-12', 'Bob');
    await settle(20);
    assert.deepEqual(log, ['read sheet-A'], 'the second has not even started reading');
    g.open();
    await Promise.all([first, second]);
    assert.deepEqual(log.filter((l) => l.startsWith('read') || l.startsWith('got')), ['read sheet-A', 'got sheet-A', 'read sheet-A', 'got sheet-A']);
  });

  it('can be waited for, and leave nothing behind once they are done (also after a failure)', async () => {
    const log: string[] = [];
    const wb = new SheetWriteBack(holdingApi(new Map(), log), 'bot@example.com', { now: () => NOW });
    const a = panelOn('sheet-A', 'Alpha Air');
    const ok = wb.claim(a, KEY, 'Alice');
    const bad = wb.claim(a, 'KJFK-KLAX@2026-12-30', 'Bob'); // not in the sheet
    await assert.rejects(bad, /can't find that flight/);
    await ok;
    await wb.idle();
    assert.equal((wb as unknown as { queues: Map<string, unknown> }).queues.size, 0);
    await wb.idle(); // nothing under way: returns at once
  });

  it('say in the log when one was slow, and how much of it was waiting in line', async () => {
    const { log, lines } = recorder();
    const g = gate();
    const wb = new SheetWriteBack(holdingApi(new Map([['sheet-A', g.opened]]), []), 'bot@example.com', { now: () => NOW, logger: log });
    const a = panelOn('sheet-A', 'Alpha Air');
    const done = wb.claim(a, KEY, 'Alice');
    await settle(20);
    await new Promise((r) => setTimeout(r, 2100));
    g.open();
    await done;
    assert.ok(lines.some((l) => /Slow: a write to the airline's sheet waited 0\.0 s in line and took 2\.\d s/.test(l)), lines.join(' | '));
  });
});

/* ------------------------------------------------------------------ the Google Sheets calls */

describe('reading a tab from Google', () => {
  const { account, publicKey } = makeServiceAccount();
  const ref: SheetRef = { id: SHEET_ID, gid: String(TAB_GID) };
  let g: FakeGoogle;
  let clock: number;
  let api: SheetsApi;
  beforeEach(() => {
    g = new FakeGoogle(publicKey);
    clock = NOW;
    api = new SheetsApi(tokenProvider(account, g.fetchFn, () => clock), g.fetchFn, () => clock);
  });
  const metadataCalls = () => g.calls.filter((c) => c.method === 'GET' && /\?fields=/.test(c.url)).length;
  const valueCalls = () => g.calls.filter((c) => c.method === 'GET' && c.url.includes('/values/')).length;

  it('asks for the tab\'s name once, not before every read', async () => {
    await api.readTab(ref);
    await api.readTab(ref);
    await api.readTab(ref);
    assert.equal(metadataCalls(), 1);
    assert.equal(valueCalls(), 3);
  });

  it('asks for the name again after a few minutes, or when told what it has was wrong', async () => {
    await api.readTab(ref);
    clock += 6 * 60_000;
    await api.readTab(ref);
    assert.equal(metadataCalls(), 2, 'after its time was up');
    api.forgetTab(ref);
    await api.readTab(ref);
    assert.equal(metadataCalls(), 3, 'after being told to forget it');
  });

  it('copes with a tab that was renamed: asks again at once and reads it', async () => {
    await api.readTab(ref);
    g.title = 'Renamed Tab';
    const tab = await api.readTab(ref);
    assert.equal(tab.title, 'Renamed Tab');
    assert.ok(tab.values.length > 1);
    assert.equal(metadataCalls(), 2);
    await api.readTab(ref);
    assert.equal(metadataCalls(), 2, 'and keeps the new name');
  });

  it('gives up with a plain message when the tab cannot be found even by its new name', async () => {
    await api.readTab(ref);
    const missing: SheetRef = { id: SHEET_ID, gid: '999' };
    await assert.rejects(api.readTab(missing), (e: unknown) => e instanceof SheetsError && e.code === 'NOT_FOUND');
  });

  it('refuses an answer far bigger than any schedule, rather than holding it in memory and parsing it', async () => {
    const huge = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('?fields=')) return new Response(JSON.stringify({ sheets: [{ properties: { sheetId: TAB_GID, title: 'T' } }] }), { status: 200 });
      return new Response('{"values":[]}', { status: 200, headers: { 'content-length': '40000000' } });
    }) as typeof fetch;
    const big = new SheetsApi(async () => 'tok', huge);
    await assert.rejects(big.readTab(ref), (e: unknown) => e instanceof SheetsError && /too large/.test(e.message));
  });

  it('still reads a normal answer, and a reply that is not JSON is an empty one rather than a crash', async () => {
    const odd = (async (url: string | URL | Request) => (String(url).includes('?fields=') ? new Response(JSON.stringify({ sheets: [{ properties: { sheetId: TAB_GID, title: 'T' } }] })) : new Response('<html>oops'))) as typeof fetch;
    const tab = await new SheetsApi(async () => 'tok', odd).readTab(ref);
    assert.deepEqual(tab.values, []);
  });
});

/* ------------------------------------------------------------------ typing, and noting what is slow */

describe('while the bot works on a reply in a DM', () => {
  it('shows nothing for a quick one, so it costs no request', async () => {
    let pings = 0;
    const out = await whileTyping({ sendTyping: async () => void pings++ }, async () => 'done');
    assert.equal(out, 'done');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pings, 0);
  });

  it('shows that it is typing when it takes a moment, and stops when it is done, even if it failed', async () => {
    let pings = 0;
    const channel = { sendTyping: async () => void pings++ };
    await whileTyping(channel, () => new Promise((r) => setTimeout(r, 1000)));
    assert.equal(pings, 1);
    await assert.rejects(
      whileTyping(channel, async () => {
        await new Promise((r) => setTimeout(r, 800));
        throw new Error('boom');
      }),
      /boom/,
    );
    const after = pings;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pings, after, 'nothing keeps typing afterwards');
  });

  it('works with a channel that cannot show it, and one whose request is refused', async () => {
    assert.equal(await whileTyping({}, async () => 1), 1);
    assert.equal(await whileTyping(null, async () => 2), 2);
    assert.equal(
      await whileTyping({ sendTyping: async () => Promise.reject(new Error('no')) }, () => new Promise<number>((r) => setTimeout(() => r(3), 800))),
      3,
    );
  });

  it('notes in the log only what took long, and never who or what', () => {
    const { log, lines } = recorder();
    noteIfSlow(log, 'a message in a DM', 1999);
    assert.deepEqual(lines, []);
    noteIfSlow(log, '/setup refresh', 14_400);
    assert.deepEqual(lines, ['info Slow: /setup refresh took 14.4 s']);
  });
});

/* ------------------------------------------------------------------ looking up the panel's messages */

describe('looking up the messages of a panel', () => {
  type Msg = { id: string; editable: boolean; deletable: boolean; edit(): Promise<void>; delete(): Promise<void> };
  const msg = (id: string): Msg => ({ id, editable: true, deletable: true, edit: async () => undefined, delete: async () => undefined });
  const unknown = () => Object.assign(new Error('Unknown Message'), { code: 10008 });

  it('takes the ones in the latest batch from it, and asks by itself only for the rest', async () => {
    const asked: string[] = [];
    const lookup = {
      fetch: async (o: any) => {
        if ('limit' in o) {
          asked.push('batch');
          return new Map([['b', msg('b')], ['c', msg('c')]]);
        }
        asked.push(o.message);
        if (o.message === 'gone') throw unknown();
        return msg(o.message);
      },
    };
    const found = await lookUpMessages(lookup, ['a', 'b', 'c', 'gone']);
    assert.deepEqual(found.map((m) => (m as Msg | null)?.id ?? null), ['a', 'b', 'c', null]);
    assert.deepEqual(asked.sort(), ['a', 'batch', 'gone']);
  });

  it('makes no batch request for a single message', async () => {
    const asked: unknown[] = [];
    await lookUpMessages({ fetch: async (o: any) => (asked.push(o), msg('a')) }, ['a']);
    assert.deepEqual(asked, [{ message: 'a', force: true }]);
  });

  it('falls back to asking one at a time when the batch cannot be had', async () => {
    const lookup = {
      fetch: async (o: any) => {
        if ('limit' in o) throw new Error('Discord is slow');
        return msg(o.message);
      },
    };
    const found = await lookUpMessages(lookup, ['a', 'b']);
    assert.deepEqual(found.map((m) => (m as Msg).id), ['a', 'b']);
  });

  it('counts any failure as "gone" for a panel (it is put back), but only a missing message as gone for a list in a DM (a hiccup is not a deletion)', async () => {
    const lookup = { fetch: async (o: any) => (o.message === 'x' ? Promise.reject(new Error('socket hang up')) : msg(o.message)) };
    assert.equal((await lookUpMessages(lookup, ['x', 'y']))[0], null);
    await assert.rejects(lookUpMessages(lookup, ['x', 'y'], true), /socket hang up/);
    const gone = { fetch: async (o: any) => (o.message === 'x' ? Promise.reject(unknown()) : msg(o.message)) };
    assert.equal((await lookUpMessages(gone, ['x', 'y'], true))[0], null);
  });
});

/* ------------------------------------------------------------------ stopping */

describe('stopping the bot while it is working', () => {
  const steps = (calls: string[]) => ({
    jobs: { expireDue: () => (calls.push('expire'), []), cleanup: () => void calls.push('cleanup') } as any,
    refresher: { refreshDue: async () => (calls.push('refresh'), 0) } as any,
  });

  it('starts no further step of the FsHub lane once stopped, and does not call a step cut short a failure', async () => {
    const { log, lines } = recorder();
    const calls: string[] = [];
    const g = gate();
    const { jobs, refresher } = steps(calls);
    const scheduler = new Scheduler(jobs, refresher, {
      logger: log,
      fshub: {
        run: async () => {
          calls.push('fshub');
          await g.opened;
          throw new Error('database is not open');
        },
      },
      autoComplete: { run: async () => void calls.push('autoComplete') },
      live: { run: async () => void calls.push('live') },
    });
    await scheduler.tick();
    await settle(20);
    assert.ok(calls.includes('fshub'));
    scheduler.stop();
    g.open();
    await scheduler.idle();
    assert.ok(!calls.includes('autoComplete') && !calls.includes('live'), calls.join(' '));
    assert.deepEqual(lines, [], 'the failure of a step that was cut short by the shutdown is not logged');
  });

  it('logs a failure of a step as it always did while it is not stopping', async () => {
    const { log, lines } = recorder();
    const { jobs, refresher } = steps([]);
    const scheduler = new Scheduler(jobs, refresher, {
      logger: log,
      fshub: { run: async () => Promise.reject(new Error('FsHub down')) },
      autoComplete: { run: async () => undefined },
    });
    await scheduler.tick();
    await scheduler.idle();
    assert.deepEqual(lines, ['error FsHub roster and flight sync failed']);
  });

  it('does no pass of work once stopped, and works again if started again', async () => {
    const calls: string[] = [];
    const { jobs, refresher } = steps(calls);
    const scheduler = new Scheduler(jobs, refresher, { tickMs: 3_600_000 });
    scheduler.stop();
    await scheduler.tick();
    assert.equal(calls.length, 0);
    scheduler.start();
    await settle(20);
    assert.ok(calls.includes('refresh'), 'started again');
    scheduler.stop();
  });

  it('stops after the step it is in: the main pass takes no further step', async () => {
    const calls: string[] = [];
    const g = gate();
    const scheduler = new Scheduler(
      { expireDue: () => (calls.push('expire'), []), cleanup: () => void calls.push('cleanup') } as any,
      {
        refreshDue: async () => {
          calls.push('refresh');
          await g.opened;
          return 0;
        },
      } as any,
      { reminders: { run: async () => (calls.push('reminders'), 0) } },
    );
    const pass = scheduler.tick();
    await settle(10);
    scheduler.stop();
    g.open();
    await pass;
    assert.deepEqual(calls, ['refresh'], 'it did not go on to expire, clean up or remind');
  });
});

describe('the panels, when the bot stops', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('draw nothing for a redraw that was already asked for and waiting its turn', async () => {
    const asked = d.panels.refresh(h.panel.id);
    d.panels.stop();
    assert.equal(await asked, 'skipped');
    assert.equal(d.client.channel(CHANNEL).live.length, 0);
  });

  it('keep only a bounded number of pictures, the most recently asked for', () => {
    const panels = d.panels as unknown as { rememberAvatar(id: string, e: { at: number; avatar: unknown }): void; avatarCache: Map<string, unknown> };
    for (let i = 0; i < 2_600; i++) panels.rememberAvatar(`u${i}`, { at: i, avatar: {} });
    assert.equal(panels.avatarCache.size, 2_000);
    assert.ok(panels.avatarCache.has('u2599') && !panels.avatarCache.has('u0'));
  });

  it('forget, as they pass, the people whose half hour is long over', () => {
    const panels = d.panels as unknown as { rememberEntitled(key: string): void; entitledAt: Map<string, number> };
    for (let i = 0; i < 900; i++) panels.rememberEntitled(`1:${i}`);
    assert.equal(panels.entitledAt.size, 900, 'all recent: kept');
    h.clock.advance(31 * 60_000);
    panels.rememberEntitled('1:new');
    assert.equal(panels.entitledAt.size, 1, 'the old ones are forgotten');
  });
});

/* ------------------------------------------------------------------ /setup refresh */

describe('/setup refresh', () => {
  const setup = setupCommand;
  const guild = { channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => true }) }) }, members: { me: {}, fetchMe: async () => ({}) } };
  let h: Harness;
  let d: DiscordHarness;
  let forced: boolean[];
  /** Only a redraw asked for by the command counts: the panel also redraws itself, a moment after a flight changes. */
  let recording = false;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    forced = [];
    recording = false;
    const real = d.ctx.panels.refresh.bind(d.ctx.panels);
    d.ctx.panels.refresh = (id: number, opts: { force?: boolean } = {}) => {
      if (recording) forced.push(opts.force === true);
      return real(id, opts);
    };
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
    delete process.env.FPB_VERSION;
  });
  const refresh = async () => {
    const f = fakeInteraction({ sub: 'refresh', admin: true, guild });
    recording = true;
    await setup.execute(d.ctx, f.i);
    recording = false;
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };

  it('sends every message again the first time after an upgrade, and after that only edits what changed', async () => {
    process.env.FPB_VERSION = '1.0.0';
    assert.match(await refresh(), /Redrew/);
    assert.match(await refresh(), /Redrew/);
    assert.match(await refresh(), /Redrew/);
    assert.deepEqual(forced, [true, false, false]);
  });

  it('does it again for a new version', async () => {
    process.env.FPB_VERSION = '1.0.0';
    await refresh();
    await refresh();
    process.env.FPB_VERSION = '1.1.0';
    await refresh();
    await refresh();
    assert.deepEqual(forced, [true, false, true, false]);
  });

  it('does not count a redraw that failed: the next one is the full one', async () => {
    process.env.FPB_VERSION = '2.0.0';
    const channel = d.client.channel(CHANNEL);
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    const send = channel.send.bind(channel);
    channel.send = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    };
    assert.doesNotMatch(await refresh(), /Redrew/);
    channel.send = send;
    assert.match(await refresh(), /Redrew/);
    assert.match(await refresh(), /Redrew/);
    assert.deepEqual(forced, [true, true, false]);
  });
});

/* ------------------------------------------------------------------ several airlines' schedules due together */

describe('reading the schedules that are all due in the same minute', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  /** Several airlines, each with a source whose download is held until it is let go. */
  function airlines(count: number, failing: number[] = []) {
    const panels = [h.panel, ...Array.from({ length: count - 1 }, (_, i) => h.store.createPanel({ guildId: GUILD, name: `Air ${i}`, prefix: `A${i}`, channelId: CHANNEL, now: NOW }))];
    const gates = new Map<number, ReturnType<typeof gate>>();
    let inFlight = 0;
    let most = 0;
    const finished: number[] = [];
    const sourceFor = (panel: { id: number }) => ({
      kind: 'test',
      fetch: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        const g = gate();
        gates.set(panel.id, g);
        await g.opened;
        inFlight--;
        finished.push(panel.id);
        if (failing.includes(panel.id)) throw new Error('Google is down');
        return [sj(`k${panel.id}`, 'EGLL-EGKK')];
      },
    });
    return { panels, gates, sourceFor, most: () => most, finished };
  }

  it('are read a few at a time, so one slow sheet does not make every other airline wait for it', async () => {
    const a = airlines(5);
    const { SourceRefresher } = await import('../src/services/refresh.js');
    const refresher = new SourceRefresher(h.store, h.jobs, a.sourceFor as never, undefined, () => h.clock.now);
    const all = refresher.refreshDue();
    await settle(30);
    assert.equal(a.gates.size, 3, 'three started at once, not five and not one');
    // Letting the first go starts the next, while the other two are still waiting.
    a.gates.get(a.panels[0]!.id)!.open();
    await settle(30);
    assert.equal(a.gates.size, 4);
    for (const g of a.gates.values()) g.open();
    await settle(30);
    for (const g of a.gates.values()) g.open();
    assert.equal(await all, 5);
    assert.equal(a.most(), 3);
    assert.equal(new Set(a.finished).size, 5, 'every airline was read');
  });

  it('go on to the others when one fails, and count only the ones that worked', async () => {
    const a = airlines(4, [h.panel.id]);
    const { SourceRefresher } = await import('../src/services/refresh.js');
    const refresher = new SourceRefresher(h.store, h.jobs, a.sourceFor as never, undefined, () => h.clock.now);
    const all = refresher.refreshDue();
    for (let i = 0; i < 10; i++) {
      await settle(10);
      for (const g of a.gates.values()) g.open();
    }
    assert.equal(await all, 3);
    assert.match(h.store.getPanel(h.panel.id)!.lastRefreshError ?? '', /Google is down/);
  });
});

/* ------------------------------------------------------------------ what a slow redraw says */

describe('a panel redraw that takes a while', () => {
  it('says in the log how many messages it edited and posted, so it can be seen what made it slow', async () => {
    const { PanelService } = await import('../src/discord/panel.js');
    const { FakeClient } = await import('./discord-helpers.js');
    const { log, lines } = recorder();
    const h = await makeHarness();
    try {
      const client = new FakeClient();
      const panels = new PanelService(h.store, h.jobs, log, () => h.clock.now, 0, 0);
      panels.attach(client as never);
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      const channel = client.channel(CHANNEL);
      const send = channel.send.bind(channel);
      channel.send = async (p: unknown) => {
        await new Promise((r) => setTimeout(r, 3100)); // Discord is slow to answer
        return send(p);
      };
      assert.equal(await panels.refresh(h.panel.id), 'posted');
      assert.ok(lines.some((l) => /^info Slow: drawing panel \d+ \(posted: 0 edited, [1-9]\d* posted, of [1-9]\d* messages\) took \d\.\d s$/.test(l)), lines.join(' | '));
      // A quick redraw says nothing.
      channel.send = send;
      lines.length = 0;
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { notes: 'changed' })]);
      assert.equal(await panels.refresh(h.panel.id), 'updated');
      assert.deepEqual(lines, []);
    } finally {
      await h.close();
    }
  });
});
