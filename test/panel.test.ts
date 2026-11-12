import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { PanelService } from '../src/discord/panel.js';
import { jobBlock, panelButtons, renderPanel } from '../src/discord/ui.js';
import { legList, routeText } from '../src/util/format.js';
import { silentLogger } from '../src/util/log.js';
import { CHANNEL, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { FakeUser, makeDiscordHarness, settle, unknownMessage, type DiscordHarness } from './discord-helpers.js';

describe('format helpers', () => {
  it('routeText chains connected legs and lists disconnected ones', () => {
    assert.equal(routeText([{ dep: 'EGLL', arr: 'EGKK' }]), 'EGLL → EGKK');
    assert.equal(routeText([{ dep: 'EGLL', arr: 'EGKK' }, { dep: 'EGKK', arr: 'EGCC' }]), 'EGLL → EGKK → EGCC');
    assert.equal(routeText([{ dep: 'EGLL', arr: 'EGKK' }, { dep: 'EGPH', arr: 'EGCC' }]), 'EGLL → EGKK, EGPH → EGCC');
  });

  it('legList reads naturally', () => {
    assert.equal(legList([1]), '1');
    assert.equal(legList([3, 1]), '1 and 3');
    assert.equal(legList([1, 2, 4]), '1, 2 and 4');
  });
});

describe('panel rendering', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  const view = (i = 0) => h.jobs.open(h.panel.id)[i]!;

  it('shows a single-leg flight with its airframe, deadline, pay and an open slot', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { aircraft: 'A20N', deadline: T0 + 5 * HOUR, pay: '12,500', title: 'Gatwick hop', notes: 'quick' })]);
    const text = jobBlock(view(), T0);
    assert.match(text, /\*\*TST-001\*\* · EGLL → EGKK · ✈ A20N/);
    assert.match(text, /⏰ complete by <t:\d+:f> \(<t:\d+:R>\)/);
    assert.match(text, /💰 12,500/);
    assert.match(text, /\*Gatwick hop - quick\*/);
    assert.match(text, /↳ \*open\*$/);
  });

  it("puts the reserver's mention next to a single-leg flight", () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(view().job.id, [1], USER_A);
    assert.match(jobBlock(view(), T0), new RegExp(`↳ <@${USER_A.discordId}>$`));
  });

  it('lists each leg of a multi-leg flight with its own holder', () => {
    h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGCC-EGPH')]);
    const id = view().job.id;
    h.jobs.reserve(id, [1, 3], USER_A);
    h.jobs.reserve(id, [2], USER_B);
    const text = jobBlock(view(), T0);
    assert.match(text, /EGLL → EGKK → EGCC → EGPH \(3 legs\)/);
    assert.match(text, new RegExp(`↳ \`1\` EGLL → EGKK — <@${USER_A.discordId}>`));
    assert.match(text, new RegExp(`↳ \`2\` EGKK → EGCC — <@${USER_B.discordId}>`));
    assert.match(text, new RegExp(`↳ \`3\` EGCC → EGPH — <@${USER_A.discordId}>`));
  });

  it('shows a start time only while it is still in the future, and copes with no details', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { availableFrom: T0 + 3 * HOUR, aircraft: null, deadline: null })]);
    assert.match(jobBlock(view(), T0), /🕐 from/);
    assert.doesNotMatch(jobBlock(view(), T0 + 4 * HOUR), /🕐/);
    assert.doesNotMatch(jobBlock(view(), T0), /✈|⏰/);
  });

  it('renders an empty panel with a friendly message and the prefix example', () => {
    const [e] = renderPanel(h.panel, [], T0);
    const json = e!.toJSON();
    assert.match(json.title!, /Test Air \(TST\) · open flights/);
    assert.match(json.description!, /No flights are listed right now/);
    assert.match(json.description!, /TST-001/);
  });

  it('orders jobs by deadline, soonest first, with no-deadline jobs last', () => {
    h.jobs.sync(h.panel.id, [sj('none', 'EGLL-EGKK', { deadline: null }), sj('late', 'EGLL-EGCC', { deadline: T0 + 30 * HOUR }), sj('soon', 'EGLL-EGPH', { deadline: T0 + 2 * HOUR })]);
    const text = renderPanel(h.panel, h.jobs.open(h.panel.id), T0)[0]!.toJSON().description!;
    // (the intro text mentions TST-001 as an example, so look for the bold job headings)
    const at = (code: string) => text.indexOf(`**${code}**`);
    assert.ok(at('TST-003') >= 0 && at('TST-003') < at('TST-002') && at('TST-002') < at('TST-001'));
  });

  it('splits a long list across embeds that each fit Discord limits, title and footer once', () => {
    h.jobs.sync(h.panel.id, Array.from({ length: 70 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(120), title: 't'.repeat(40) })));
    const embeds = renderPanel(h.panel, h.jobs.open(h.panel.id), T0).map((e) => e.toJSON());
    assert.ok(embeds.length > 1);
    assert.ok(embeds.every((e) => e.description!.length <= 4096), 'every description within the embed limit');
    assert.equal(embeds.filter((e) => e.title).length, 1);
    assert.ok(embeds[0]!.title && !embeds.at(-1)!.title);
    assert.equal(embeds.filter((e) => e.footer).length, 1);
    assert.ok(embeds.at(-1)!.footer);
    // every job appears exactly once
    const all = embeds.map((e) => e.description).join('\n');
    for (let n = 1; n <= 70; n++) assert.equal(all.split(`**TST-${String(n).padStart(3, '0')}**`).length - 1, 1, `TST-${n}`);
  });

  it('caps the panel at 10 messages and says how many flights are not shown', () => {
    h.jobs.sync(h.panel.id, Array.from({ length: 400 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC-EGPH', { notes: 'n'.repeat(150) })));
    const embeds = renderPanel(h.panel, h.jobs.open(h.panel.id), T0).map((e) => e.toJSON());
    assert.equal(embeds.length, 10);
    assert.match(embeds.at(-1)!.description!, /…and \d+ more flights not shown/);
    assert.ok(embeds.every((e) => e.description!.length <= 4096));
  });

  it('has Reserve, My flights and Complete buttons that carry the panel id', () => {
    const row = panelButtons(7).toJSON();
    assert.deepEqual(row.components.map((c: any) => c.custom_id), ['panel:reserve:7', 'panel:mine:7', 'panel:complete:7']);
  });
});

describe('PanelService', () => {
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

  const pid = () => h.panel.id;
  const channel = () => d.client.channel(CHANNEL);

  it('posts the panel once, with the buttons on the message', async () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    assert.equal(await d.panels.refresh(pid()), 'posted');
    assert.equal(channel().live.length, 1);
    const msg = channel().live[0]!;
    assert.equal(msg.payload.components[0].toJSON().components[0].custom_id, `panel:reserve:${pid()}`);
    assert.deepEqual(msg.payload.allowedMentions, { parse: [] });
    assert.deepEqual(h.store.getPanel(pid())!.messageIds, [msg.id]);
  });

  describe('a panel long enough to span several messages', () => {
    const longList = () => Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) }));
    const buttonIds = (m: { payload: any }) => m.payload.components.map((r: any) => r.toJSON()).flatMap((r: any) => r.components.map((c: any) => c.custom_id));

    it('puts the buttons on every message, not just the last', async () => {
      h.jobs.sync(pid(), longList());
      await d.panels.refresh(pid());
      assert.ok(channel().live.length > 1, 'the list really is split over several messages');
      for (const m of channel().live) assert.deepEqual(buttonIds(m), [`panel:reserve:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`]);
    });

    it('keeps them on every message when the panel is edited in place', async () => {
      h.jobs.sync(pid(), longList());
      await d.panels.refresh(pid());
      const first = channel().live.map((m) => m.id);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      await settle();
      assert.deepEqual(channel().live.map((m) => m.id), first, 'edited, not reposted');
      for (const m of channel().live) assert.deepEqual(buttonIds(m), [`panel:reserve:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`]);
    });

    it('puts them on a message that was the last one, and then no longer is', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      await d.panels.refresh(pid());
      h.jobs.sync(pid(), longList());
      await settle();
      assert.ok(channel().live.length > 1);
      for (const m of channel().live) assert.equal(buttonIds(m).length, 3);
    });
  });

  it('edits the same message in place when things change', async () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
    const first = channel().live[0]!;
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    await settle();
    assert.equal(channel().live.length, 1, 'no second message');
    assert.ok(first.edits.length >= 1);
    assert.match(JSON.stringify(first.payload.embeds[0].toJSON()), new RegExp(`<@${USER_A.discordId}>`));
  });

  it("shows a reserver's name on the panel as soon as they reserve (event-driven)", async () => {
    h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC')]);
    await settle();
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [2], USER_B);
    await settle();
    assert.match(channel().live[0]!.payload.embeds[0].toJSON().description!, new RegExp(`\`2\` EGKK → EGCC — <@${USER_B.discordId}>`));
  });

  it('reposts in the right order if a panel message was deleted', async () => {
    h.jobs.sync(pid(), Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) })));
    await d.panels.refresh(pid());
    const before = [...channel().live];
    assert.ok(before.length > 1);
    channel().deleteMessage(before[0]!.id);
    assert.equal(await d.panels.refresh(pid()), 'posted');
    const after = channel().live;
    assert.equal(after.length, before.length);
    assert.ok(after.every((m) => !before.includes(m)), 'a fresh set, so order is right');
    assert.deepEqual(h.store.getPanel(pid())!.messageIds, after.map((m) => m.id));
  });

  it('grows and shrinks the number of messages as the list changes', async () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
    assert.equal(channel().live.length, 1);
    h.jobs.sync(pid(), Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) })));
    await settle();
    const many = channel().live.length;
    assert.ok(many > 1);
    h.jobs.sync(pid(), []);
    await settle();
    assert.equal(channel().live.length, 1);
  });

  it('reports a missing or unwritable channel as no-access and a missing panel as skipped', async () => {
    d.client.deleteAllChannels();
    assert.equal(await d.panels.refresh(pid()), 'no-access');
    assert.equal(await d.panels.refresh(99999), 'skipped');
  });

  describe('when a person deletes the panel message (the bot never hears about it, so its cache is stale)', () => {
    it('posts the panel again, and keeps editing it normally afterwards', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      await d.panels.refresh(pid());
      const original = channel().live[0]!;
      channel().deleteMessage(original.id); // deleted in Discord; still in the bot's cache

      assert.equal(await d.panels.refresh(pid()), 'posted');
      assert.equal(channel().live.length, 1);
      const replacement = channel().live[0]!;
      assert.notEqual(replacement.id, original.id);
      assert.deepEqual(h.store.getPanel(pid())!.messageIds, [replacement.id]);

      // and it did not fall into a failing loop: later changes edit the new message
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      await settle();
      assert.equal(channel().live.length, 1);
      assert.ok(replacement.edits.length >= 1);
    });

    it('asks Discord rather than trusting its cache', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      await d.panels.refresh(pid());
      const before = channel().apiFetches;
      await d.panels.refresh(pid());
      assert.ok(channel().apiFetches > before, 'a refresh checks with the API that the message still exists');
    });

    it('recovers if the message vanishes between the check and the edit', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      await d.panels.refresh(pid());
      const m = channel().live[0]!;
      m.edit = async () => {
        channel().deleteMessage(m.id); // someone deleted it at that very moment
        throw unknownMessage();
      };
      assert.equal(await d.panels.refresh(pid()), 'posted');
      assert.equal(channel().live.length, 1);
      assert.notEqual(channel().live[0]!.id, m.id);
    });

    it('survives every message of a multi-message panel being deleted', async () => {
      h.jobs.sync(pid(), Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) })));
      await d.panels.refresh(pid());
      const count = channel().live.length;
      assert.ok(count > 1);
      for (const m of [...channel().live]) channel().deleteMessage(m.id);
      assert.equal(await d.panels.refresh(pid()), 'posted');
      assert.equal(channel().live.length, count);
    });
  });

  describe('telling a permissions problem from other failures', () => {
    it('a Discord "missing permissions" error is no-access', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      const ch = channel();
      for (const code of [50013, 50001]) {
        ch.send = async () => {
          throw Object.assign(new Error('Missing Permissions'), { code });
        };
        assert.equal(await d.panels.refresh(pid()), 'no-access', String(code));
      }
    });

    it('anything else is a plain failure, not blamed on permissions', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      channel().send = async () => {
        throw new Error('something odd');
      };
      assert.equal(await d.panels.refresh(pid()), 'failed');
    });
  });

  it('collapses a burst of changes into one redraw', async () => {
    const svc = new PanelService(h.store, h.jobs, silentLogger, () => T0, 30);
    svc.attach(d.client as unknown as Client);
    for (let i = 0; i < 5; i++) svc.schedule(pid());
    await settle(90);
    assert.equal(channel().live.length, 1);
    svc.stop();
  });

  it('deleteMessages removes the panel from the channel', async () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
    await d.panels.deleteMessages(h.store.getPanel(pid())!);
    assert.equal(channel().live.length, 0);
  });
});

describe('Notifier', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('DMs a pilot when their flight is removed, with the legs they lost', async () => {
    h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGCC')]);
    h.jobs.reserve(h.jobs.open(h.panel.id)[0]!.job.id, [1, 2], USER_A);
    h.jobs.sync(h.panel.id, []);
    await settle();
    assert.match(alice.lastText, /TST-001.*legs 1 and 2.*no longer listed/);
    assert.deepEqual(alice.last.allowedMentions, { parse: [] });
  });

  it('explains a changed route and an admin release differently', async () => {
    h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGCC')]);
    const id = h.jobs.open(h.panel.id)[0]!.job.id;
    h.jobs.reserve(id, [2], USER_A);
    h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGPH')]);
    await settle();
    assert.match(alice.lastText, /leg 2.*different route/);

    h.jobs.reserve(id, [1], USER_A);
    h.jobs.adminRelease(h.store.getPanel(h.panel.id)!, 'TST-001', 1);
    await settle();
    assert.match(alice.lastText, /leg 1.*released by a server admin/);
  });

  it('does not fail when the person has DMs closed or cannot be found', async () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('b', 'EGLL-EGCC')]);
    const [a, b] = h.jobs.open(h.panel.id).map((v) => v.job.id) as [number, number];
    alice.failDms = true;
    h.jobs.reserve(a, [1], USER_A);
    h.jobs.reserve(b, [1], USER_B); // bob is unknown to the client
    assert.doesNotThrow(() => h.jobs.sync(h.panel.id, []));
    await settle();
  });
});
