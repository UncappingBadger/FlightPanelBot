import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { PanelService } from '../src/discord/panel.js';
import { embedSize, renderPanelParts } from '../src/discord/ui.js';
import { COMPLETED_SHOW_MS, PANEL_HORIZON_MS } from '../src/services/jobs.js';
import { Scheduler } from '../src/services/scheduler.js';
import { silentLogger } from '../src/util/log.js';
import { CHANNEL, HOUR, T0, USER_A, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeComponent, fakeDm, fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions, messageText } from './discord-helpers.js';

const DAY = 24 * HOUR;

describe('the panel lists the next 7 days of flights', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  const pid = () => h.panel.id;
  const messages = () => d.client.channel(CHANNEL).live;
  const description = (i: number) => messageText(messages()[i]!);
  /** The text of the open flights (every message but the completed flights panel). */
  const openText = () => messages().slice(0, -1).map((m) => messageText(m)).join('\n');
  const starting = (key: string, inDays: number) => sj(key, 'EGLL-EGKK', { availableFrom: T0 + inDays * DAY, deadline: T0 + (inDays + 1) * DAY });

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is a week', () => {
    assert.equal(PANEL_HORIZON_MS, 7 * DAY);
  });

  describe('which flights it lists', () => {
    it('lists flights open now, and flights that start inside the week, however far off their deadline is', async () => {
      h.jobs.sync(pid(), [
        sj('nostart', 'EGLL-EGKK', { availableFrom: null, deadline: T0 + 40 * DAY }),
        sj('started', 'EGLL-EGCC', { availableFrom: T0 - 3 * DAY, deadline: T0 + 40 * DAY }),
        starting('soon', 2),
        starting('edge', 7), // exactly a week from now is inside it
      ]);
      await d.panels.refresh(pid());
      const text = openText();
      for (const code of ['TST-001', 'TST-002', 'TST-003', 'TST-004']) assert.match(text, new RegExp(`^${code}( · |$)`, 'm'), code);
      assert.doesNotMatch(text, /more flights? start/);
    });

    it('leaves out a flight that starts more than a week from now, and says how many it left out', async () => {
      h.jobs.sync(pid(), [starting('now', 0), starting('week', 6), starting('later', 8), starting('muchlater', 30)]);
      await d.panels.refresh(pid());
      const text = openText();
      assert.match(text, /^TST-001( · |$)/m);
      assert.match(text, /^TST-002( · |$)/m);
      assert.doesNotMatch(text, /^TST-003( · |$)/m);
      assert.doesNotMatch(text, /^TST-004( · |$)/m);
      assert.match(text, /🗓️ 2 more flights start more than 7 days from now, and will be listed here once they are within 7 days\.$/);
    });

    it('says it in the singular for one flight', async () => {
      h.jobs.sync(pid(), [starting('now', 0), starting('later', 9)]);
      await d.panels.refresh(pid());
      assert.match(openText(), /🗓️ 1 more flight starts more than 7 days from now, and will be listed here once it is within 7 days\.$/);
    });

    it('says nothing when nothing was left out', async () => {
      h.jobs.sync(pid(), [starting('now', 0)]);
      await d.panels.refresh(pid());
      assert.doesNotMatch(openText(), /🗓️/);
    });

    it('still says there are no flights when every one starts after the week, and how many are coming', async () => {
      h.jobs.sync(pid(), [starting('later', 10), starting('muchlater', 20)]);
      await d.panels.refresh(pid());
      assert.match(description(0), /No flights are listed right now\.\n\n🗓️ 2 more flights start more than 7 days from now/);
      assert.equal(messages().length, 2, 'and it is still the open flights and the completed flights');
    });

    it('leaves the Complete, Reserve and My flights buttons where they were', async () => {
      h.jobs.sync(pid(), [starting('later', 10)]);
      await d.panels.refresh(pid());
      const ids = messages()[0]!.payload.components[0].toJSON().components.map((c: any) => c.custom_id);
      assert.deepEqual(ids, [`panel:reserve:${pid()}`, `panel:search:${pid()}`, `panel:backup:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`]);
    });

    it('keeps every message inside Discord\'s limit even when the list is full and some were left out', () => {
      h.jobs.sync(pid(), Array.from({ length: 400 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC-EGPH', { notes: 'n'.repeat(150) })));
      const parts = renderPanelParts(h.panel, h.jobs.open(pid()), T0, [], undefined, false, 123);
      assert.equal(parts.open.length, 8);
      for (const message of [...parts.open, ...parts.completed]) assert.ok(message.length <= 10 && message.reduce((n, e) => n + embedSize(e), 0) <= 6000);
      const tail = parts.open.at(-1)!.map((e) => e.toJSON().description ?? '');
      assert.ok(tail.some((t) => /^🗓️ 123 more flights start more than 7 days from now/.test(t)), 'the note about later flights is there');
      assert.ok(tail.some((t) => /^…and \d+ more flights not shown\.$/.test(t)), 'and the note about those that did not fit');
    });

    it('is only about what the panel shows: a flight beyond the week can still be reserved by its code', async () => {
      h.jobs.sync(pid(), [starting('now', 0), starting('later', 20)]);
      await d.panels.refresh(pid());
      assert.doesNotMatch(openText(), /^TST-002( · |$)/m);
      const press = fakeComponent(alice, `panel:reserve:${pid()}`, {});
      await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, press.i);
      await handleDmMessage(d.ctx, fakeDm(alice, 'TST-002'));
      const later = h.store.listJobs(pid()).find((j) => j.code === 'TST-002')!;
      assert.equal(h.store.getJobView(later.id)!.legs[0]!.holder?.discordId, alice.id);
    });
  });

  describe('the number of days a panel shows (1 to 7, chosen by the manager)', () => {
    const setDays = (days: number) => h.store.updatePanel(pid(), { showDays: days });

    it('is 7 for a new panel', () => {
      assert.equal(h.store.getPanel(pid())!.showDays, 7);
    });

    it('lists flights open now or starting within the chosen days, and leaves the rest off with a note in those days', async () => {
      setDays(3);
      h.jobs.sync(pid(), [starting('now', 0), starting('two', 2), starting('three', 3), starting('four', 4), starting('six', 6)]);
      await d.panels.refresh(pid());
      const text = openText();
      for (const code of ['TST-001', 'TST-002', 'TST-003']) assert.match(text, new RegExp(`^${code}( · |$)`, 'm'), code);
      assert.doesNotMatch(text, /^TST-004( · |$)|^TST-005( · |$)/m);
      assert.match(text, /🗓️ 2 more flights start more than 3 days from now, and will be listed here once they are within 3 days\.$/);
    });

    it('says "1 day" in the singular', async () => {
      setDays(1);
      h.jobs.sync(pid(), [starting('now', 0), starting('tomorrow', 1), starting('later', 2)]);
      await d.panels.refresh(pid());
      assert.match(openText(), /^TST-002( · |$)/m, 'a flight starting in exactly a day is inside it');
      assert.doesNotMatch(openText(), /^TST-003( · |$)/m);
      assert.match(openText(), /🗓️ 1 more flight starts more than 1 day from now, and will be listed here once it is within 1 day\.$/);
    });

    it('is applied per panel', async () => {
      const other = h.store.createPanel({ guildId: '9', name: 'Other Air', prefix: 'OTH', channelId: '800000000000000009', now: T0 });
      setDays(2);
      h.jobs.sync(pid(), [starting('five', 5)]);
      h.jobs.sync(other.id, [starting('five', 5)]);
      await d.panels.refresh(pid());
      await d.panels.refresh(other.id);
      assert.doesNotMatch(openText(), /^TST-001( · |$)/m, 'hidden on the panel set to 2 days');
      const otherText = d.client.channel('800000000000000009').live.slice(0, -1).map((m) => messageText(m)).join('\n');
      assert.match(otherText, /^OTH-001( · |$)/m, 'shown on the panel left at 7');
    });

    it('redraws the panel at once when it is changed, and again as time brings flights inside the new period', async () => {
      h.jobs.sync(pid(), [starting('now', 0), starting('four', 4)]);
      await d.panels.refresh(pid());
      assert.match(openText(), /^TST-002( · |$)/m);
      setDays(2);
      await d.panels.refresh(pid());
      assert.doesNotMatch(openText(), /^TST-002( · |$)/m);
      h.clock.now = T0 + 2 * DAY; // it now starts in two days
      d.panels.run();
      await settle(40);
      assert.match(openText(), /^TST-002( · |$)/m);
    });

    it('never goes outside 1 to 7, whatever is stored or asked for', () => {
      assert.throws(() => setDays(0), /1 to 7/);
      assert.throws(() => setDays(8), /1 to 7/);
      assert.throws(() => setDays(2.5), /1 to 7/);
      const raw = (h.store as unknown as { db: { prepare(sql: string): { run(...args: number[]): unknown } } }).db; // a damaged value, bypassing the setter
      for (const [stored, shown] of [[0, 1], [-4, 1], [99, 7], [3, 3]] as const) {
        raw.prepare('UPDATE panels SET show_days = ? WHERE id = ?').run(stored, pid());
        assert.equal(h.store.getPanel(pid())!.showDays, shown, `${stored} is read as ${shown}`);
      }
    });
  });

  describe('as time passes', () => {
    it('lists a flight once it comes within the week, with nothing else having changed', async () => {
      h.jobs.sync(pid(), [starting('now', 0), starting('later', 9)]);
      await d.panels.refresh(pid());
      assert.doesNotMatch(openText(), /^TST-002( · |$)/m);

      h.clock.now = T0 + 1 * DAY + HOUR; // it now starts in 7 days and 23 hours
      d.panels.run();
      await settle(40);
      assert.doesNotMatch(openText(), /^TST-002( · |$)/m, 'not yet');

      h.clock.now = T0 + 2 * DAY; // it now starts in exactly 7 days
      d.panels.run();
      await settle(40);
      assert.match(openText(), /^TST-002( · |$)/m);
      assert.doesNotMatch(openText(), /🗓️/, 'and the note about later flights goes');
      assert.equal(messages().length, 2);
    });

    it('does not touch the panel at all while nothing is due', async () => {
      h.jobs.sync(pid(), [starting('now', 0), starting('later', 20)]);
      await d.panels.refresh(pid());
      await settle(40); // the change itself also draws the panel; let that finish
      const edits = () => messages().reduce((n, m) => n + m.edits.length, 0);
      const before = edits();
      for (let i = 1; i <= 5; i++) {
        h.clock.now = T0 + i * HOUR;
        d.panels.run();
      }
      await settle(40);
      assert.equal(edits(), before);
    });

    it('draws each panel again only once, not every minute after its time has come', async () => {
      h.jobs.sync(pid(), [starting('later', 9)]);
      await d.panels.refresh(pid());
      h.clock.now = T0 + 3 * DAY;
      let redraws = 0;
      const real = d.panels.refresh.bind(d.panels);
      d.panels.refresh = (id: number) => {
        redraws++;
        return real(id);
      };
      d.panels.run();
      d.panels.run();
      d.panels.run();
      await settle(40);
      assert.equal(redraws, 1);
    });

    it('takes a completed flight off the completed flights panel a day after, without anything else changing', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: T0 - HOUR, deadline: T0 + 3 * DAY })]);
      h.jobs.reserve(h.store.listJobs(pid())[0]!.id, [1], { discordId: alice.id, username: alice.username });
      h.jobs.complete(h.store.listJobs(pid())[0]!.id, alice.id);
      await d.panels.refresh(pid());
      assert.match(description(1), /Completed in the last 24 hours\./);

      h.clock.now = T0 + COMPLETED_SHOW_MS - HOUR;
      d.panels.run();
      await settle(40);
      assert.match(description(1), /Completed in the last 24 hours\./, 'still inside the day');

      h.clock.now = T0 + COMPLETED_SHOW_MS + HOUR;
      d.panels.run();
      await settle(40);
      assert.match(description(1), /Nothing has been completed in the last 24 hours\./);
    });

    it('does nothing for a panel it has not drawn since the bot started (the bot draws every panel at start-up)', async () => {
      const fresh = new PanelService(h.store, h.jobs, silentLogger, () => h.clock.now, 0);
      fresh.attach(d.client as unknown as Client);
      let asked = 0;
      fresh.refresh = async () => {
        asked++;
        return 'skipped';
      };
      h.jobs.sync(pid(), [starting('later', 9)]);
      h.clock.now = T0 + 5 * DAY;
      fresh.run();
      await settle(40);
      assert.equal(asked, 0);
      fresh.stop();
    });

    it('copes with a panel that was removed after it was drawn', async () => {
      h.jobs.sync(pid(), [starting('later', 9)]);
      await d.panels.refresh(pid());
      h.store.deletePanel(pid());
      h.clock.now = T0 + 6 * DAY;
      assert.doesNotThrow(() => d.panels.run());
      await settle(40);
      assert.doesNotThrow(() => d.panels.run(), 'and its entry is gone, so a second look finds nothing to do');
    });
  });

  describe('the scheduler', () => {
    it('looks at the panels every pass, and a failure there does not stop the rest of the pass', async () => {
      const calls: string[] = [];
      const ok = new Scheduler(h.jobs, d.refresher, { panels: { run: () => void calls.push('panels') }, markets: { run: async () => void calls.push('markets') } });
      await ok.tick();
      await ok.tick();
      assert.deepEqual(calls, ['panels', 'markets', 'panels', 'markets']);

      const failing = new Scheduler(h.jobs, d.refresher, {
        panels: {
          run: () => {
            throw new Error('boom');
          },
        },
        markets: { run: async () => void calls.push('markets again') },
      });
      await assert.doesNotReject(failing.tick());
      assert.equal(calls.at(-1), 'markets again');
    });

    it('end to end: a pass after the flight comes within the week lists it', async () => {
      h.jobs.sync(pid(), [starting('later', 10)]);
      await d.panels.refresh(pid());
      const s = new Scheduler(h.jobs, d.refresher, { panels: d.panels });
      await s.tick();
      await settle(40);
      assert.doesNotMatch(openText(), /^TST-001( · |$)/m);
      h.clock.now = T0 + 4 * DAY;
      await s.tick();
      await settle(40);
      assert.match(openText(), /^TST-001( · |$)/m);
    });
  });
});

/* ------------------------------------------------------------------ /setup window */

describe('/setup window', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const run = async (o: FakeInteractionOptions = {}, sub = 'window') => {
    const f = fakeInteraction({ sub, admin: true, ...o });
    await setup.execute(d.ctx, f.i);
    await settle(40);
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  const starting = (key: string, inDays: number) => sj(key, 'EGLL-EGKK', { availableFrom: T0 + inDays * DAY, deadline: T0 + (inDays + 1) * DAY });

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is a whole number from 1 to 7, and an optional panel', () => {
    const sub = (setup.data.toJSON().options ?? []).find((o) => o.name === 'window') as unknown as { description: string; options: Array<{ name: string; min_value?: number; max_value?: number; required?: boolean }> };
    assert.ok(sub && sub.description.length <= 100);
    const days = sub.options.find((o) => o.name === 'days')!;
    assert.deepEqual([days.min_value, days.max_value, days.required ?? false], [1, 7, false]);
    assert.ok(sub.options.some((o) => o.name === 'airline'));
  });

  it('sets the days, tells the manager what is left off, and redraws the panel', async () => {
    h.jobs.sync(pid(), [starting('now', 0), starting('four', 4), starting('six', 6)]);
    await d.panels.refresh(pid());
    const reply = await run({ options: { days: 3 } });
    assert.equal(h.store.getPanel(pid())!.showDays, 3);
    assert.match(reply, /Done\. The \*\*Test Air\*\* panel lists the flights that are open now or start within the next \*\*3 days\*\*\./);
    assert.match(reply, /2 open flights start later than that and are left off the panel until they come within 3 days\. Pilots can still reserve one by typing its flight ID\./);
    assert.match(reply, /Change it with `\/setup window days:` \(1 to 7\)\./);
    const text = d.client.channel(CHANNEL).live.slice(0, -1).map((m) => messageText(m)).join('\n');
    assert.match(text, /^TST-001( · |$)/m);
    assert.doesNotMatch(text, /^TST-002( · |$)|^TST-003( · |$)/m);
    assert.match(text, /🗓️ 2 more flights start more than 3 days from now/);
  });

  it('says so when every open flight is listed, and uses the singular for one day', async () => {
    h.jobs.sync(pid(), [starting('now', 0)]);
    const reply = await run({ options: { days: 1 } });
    assert.match(reply, /within the next \*\*1 day\*\*\./);
    assert.match(reply, /Every open flight is listed\./);
  });

  it('shows the current setting, and changes nothing, when no days are given', async () => {
    h.store.updatePanel(pid(), { showDays: 5 });
    h.jobs.sync(pid(), [starting('now', 0), starting('eight', 8)]);
    const reply = await run({});
    assert.match(reply, /^The \*\*Test Air\*\* panel lists the flights that are open now or start within the next \*\*5 days\*\*\./);
    assert.match(reply, /1 open flight starts later than that and is left off the panel until it comes within 5 days\./);
    assert.equal(h.store.getPanel(pid())!.showDays, 5);
  });

  it('refuses a value outside 1 to 7 even if the client lets it through, and changes nothing', async () => {
    for (const days of [0, 8, -1]) await assert.rejects(run({ options: { days } }), /from 1 to 7/, String(days));
    assert.equal(h.store.getPanel(pid())!.showDays, 7);
  });

  it('is for people with Manage Server only', async () => {
    await assert.rejects(run({ admin: false, options: { days: 2 } }), /Manage Server/);
    assert.equal(h.store.getPanel(pid())!.showDays, 7);
  });

  it('is shown in /setup panels', async () => {
    assert.match(await run({}, 'panels'), /panel shows the next 7 days/);
    await run({ options: { days: 1 } });
    assert.match(await run({}, 'panels'), /panel shows the next 1 day ·/);
  });
});
