import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { PanelService } from '../src/discord/panel.js';
import { COLORS, embedSize, jobBlock, openCard, panelButtons, renderPanelParts } from '../src/discord/ui.js';
import { legList, routeText } from '../src/util/format.js';
import { silentLogger } from '../src/util/log.js';
import { CHANNEL, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { FakeUser, makeDiscordHarness, messageText, settle, unknownMessage, type DiscordHarness } from './discord-helpers.js';

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
    assert.match(text, /⏰ complete by <t:\d+:F> \(<t:\d+:R>\)/);
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
    const parts = renderPanelParts(h.panel, [], T0);
    assert.equal(parts.open.length, 1);
    assert.equal(parts.open[0]!.length, 1, 'just the header card');
    const json = parts.open[0]![0]!.toJSON();
    assert.match(json.title!, /Test Air \(TST\) · open flights/);
    assert.match(json.description!, /No flights are listed right now/);
    assert.match(json.description!, /TST-001/);
  });

  describe('a flight card', () => {
    it('has its code and aircraft on top, the route in large type, labelled boxes, and who has it', () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { aircraft: 'A20N', deadline: T0 + 5 * HOUR, pay: '12,500', title: 'Gatwick hop', notes: 'quick', availableFrom: T0 + 3 * HOUR })]);
      const card = openCard(view(), T0).toJSON();
      assert.equal(card.title, 'TST-001 · A20N');
      assert.equal(card.description, '## EGLL ✈ EGKK\n*Gatwick hop - quick*');
      assert.deepEqual(card.fields!.map((f) => [f.name, f.inline]), [['OPENS', true], ['COMPLETE BY', true], ['PAY', true], ['PILOT', false]]);
      assert.match(card.fields![0]!.value, /^<t:\d+:F>$/);
      assert.match(card.fields![1]!.value, /^<t:\d+:F>\n<t:\d+:R>$/);
      assert.equal(card.fields![2]!.value, '12,500');
      assert.equal(card.fields![3]!.value, '*open*');
    });

    it("puts the reserver's mention in the PILOT box", () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      h.jobs.reserve(view().job.id, [1], USER_A);
      const pilot = openCard(view(), T0).toJSON().fields!.find((f) => f.name === 'PILOT')!;
      assert.match(pilot.value, new RegExp(`^<@${USER_A.discordId}>$`));
    });

    it('draws the route of a multi-leg flight in one line, and lists each leg with its own holder', () => {
      h.jobs.sync(h.panel.id, [sj('m', 'EGLL-EGKK-EGCC-EGPH')]);
      const id = view().job.id;
      h.jobs.reserve(id, [1, 3], USER_A);
      h.jobs.reserve(id, [2], USER_B);
      const card = openCard(view(), T0).toJSON();
      assert.equal(card.title, 'TST-001 · 3 legs · A320');
      assert.match(card.description!, /^## EGLL ✈ EGKK ✈ EGCC ✈ EGPH/);
      const legs = card.fields!.find((f) => f.name === 'PILOTS')!.value;
      assert.match(legs, new RegExp(`\`1\` EGLL → EGKK — <@${USER_A.discordId}>`));
      assert.match(legs, new RegExp(`\`2\` EGKK → EGCC — <@${USER_B.discordId}>`));
      assert.match(legs, new RegExp(`\`3\` EGCC → EGPH — <@${USER_A.discordId}>`));
    });

    it('shows when it opens only while that is still ahead, and copes with having no details', () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { availableFrom: T0 + 3 * HOUR, aircraft: null, deadline: null })]);
      assert.ok(openCard(view(), T0).toJSON().fields!.some((f) => f.name === 'OPENS'));
      assert.ok(!openCard(view(), T0 + 4 * HOUR).toJSON().fields!.some((f) => f.name === 'OPENS'));
      const bare = openCard(view(), T0).toJSON();
      assert.equal(bare.title, 'TST-001');
      assert.deepEqual(bare.fields!.map((f) => f.name), ['OPENS', 'PILOT']);
    });

    it('has an amber stripe while a leg still needs a pilot, and a blue one once every leg is taken', () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('m', 'EGLL-EGKK-EGCC')]);
      const single = () => h.jobs.open(h.panel.id).find((v) => v.job.sourceKey === 'a')!;
      const multi = () => h.jobs.open(h.panel.id).find((v) => v.job.sourceKey === 'm')!;
      assert.equal(openCard(single(), T0).toJSON().color, COLORS.open);
      h.jobs.reserve(single().job.id, [1], USER_A);
      assert.equal(openCard(single(), T0).toJSON().color, COLORS.taken);
      h.jobs.reserve(multi().job.id, [1], USER_A);
      assert.equal(openCard(multi(), T0).toJSON().color, COLORS.open, 'one leg of two is not enough');
      h.jobs.reserve(multi().job.id, [2], USER_B);
      assert.equal(openCard(multi(), T0).toJSON().color, COLORS.taken);
    });

    it('writes text from the schedule as plain text in its boxes', () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { pay: '**$5,000** <@123456789012345678>', aircraft: '@everyone' })]);
      const card = openCard(view(), T0).toJSON();
      assert.doesNotMatch(JSON.stringify(card), /<@123456789012345678>/);
      assert.doesNotMatch(card.title!, /@everyone/);
    });
  });

  it('orders the cards by deadline, soonest first, with no-deadline flights last', () => {
    h.jobs.sync(h.panel.id, [sj('none', 'EGLL-EGKK', { deadline: null }), sj('late', 'EGLL-EGCC', { deadline: T0 + 30 * HOUR }), sj('soon', 'EGLL-EGPH', { deadline: T0 + 2 * HOUR })]);
    const titles = renderPanelParts(h.panel, h.jobs.open(h.panel.id), T0).open.flat().map((e) => e.toJSON().title ?? '');
    const at = (code: string) => titles.findIndex((t) => t.startsWith(code));
    assert.ok(at('TST-003') >= 1 && at('TST-003') < at('TST-002') && at('TST-002') < at('TST-001'), titles.join(' | '));
  });

  it('packs a long list into messages of at most 10 cards and 6000 characters, with one title for the open flights, one for the completed ones, and the footer once at the very end', () => {
    h.jobs.sync(h.panel.id, Array.from({ length: 70 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(120), title: 't'.repeat(40) })));
    const parts = renderPanelParts(h.panel, h.jobs.open(h.panel.id), T0);
    assert.ok(parts.open.length > 1);
    for (const message of [...parts.open, ...parts.completed]) {
      assert.ok(message.length <= 10, `${message.length} cards in a message`);
      assert.ok(message.reduce((n, e) => n + embedSize(e), 0) <= 6000, 'within the 6000 characters Discord allows a message');
    }
    const all = [...parts.open, ...parts.completed].flat().map((e) => e.toJSON());
    assert.deepEqual(all.filter((e) => /· (open|completed) flights$/.test(e.title ?? '')).map((e) => e.title!.replace(/^\S+ /, '')), ['Test Air (TST) · open flights', 'Test Air (TST) · completed flights']);
    assert.equal(all.filter((e) => e.footer).length, 1);
    assert.ok(all.at(-1)!.footer, 'on the very last card');
    // every flight appears exactly once
    const titles = parts.open.flat().map((e) => e.toJSON().title ?? '');
    for (let n = 1; n <= 70; n++) assert.equal(titles.filter((t) => t.startsWith(`TST-${String(n).padStart(3, '0')} `)).length, 1, `TST-${n}`);
  });

  it('caps the open flights at 8 messages (the completed flights get at most 2 more) and says how many flights are not shown', () => {
    h.jobs.sync(h.panel.id, Array.from({ length: 400 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC-EGPH', { notes: 'n'.repeat(150) })));
    const parts = renderPanelParts(h.panel, h.jobs.open(h.panel.id), T0);
    assert.equal(parts.open.length, 8);
    const last = parts.open.at(-1)!;
    assert.match(last.at(-1)!.toJSON().description!, /^…and \d+ more flights not shown\.$/);
    const shown = parts.open.flat().filter((e) => /^TST-\d+ /.test(e.toJSON().title ?? '')).length;
    assert.equal(Number(/…and (\d+) more/.exec(last.at(-1)!.toJSON().description!)![1]) + shown, 400, 'shown and not shown add up to every flight');
    for (const message of [...parts.open, ...parts.completed]) assert.ok(message.reduce((n, e) => n + embedSize(e), 0) <= 6000);
    assert.ok(parts.open.length + parts.completed.length <= 10, 'a panel is never more than ten messages');
  });

  it('has Reserve, Search, Backup pilot, My flights and Complete buttons that carry the panel id', () => {
    const row = panelButtons(7).toJSON();
    assert.deepEqual(row.components.map((c: any) => c.custom_id), ['panel:reserve:7', 'panel:search:7', 'panel:backup:7', 'panel:mine:7', 'panel:complete:7']);
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

  it('posts the panel once: the open flights with the buttons, then the completed flights as a panel of their own, without', async () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    assert.equal(await d.panels.refresh(pid()), 'posted');
    assert.equal(channel().live.length, 2);
    const [open, done] = channel().live as [any, any];
    assert.equal(open.payload.components[0].toJSON().components[0].custom_id, `panel:reserve:${pid()}`);
    assert.deepEqual(open.payload.allowedMentions, { parse: [] });
    assert.match(open.payload.embeds[0].toJSON().title, /open flights/);
    assert.deepEqual(done.payload.components, [], 'no buttons under the completed flights');
    assert.match(done.payload.embeds[0].toJSON().title, /completed flights/);
    assert.match(done.payload.embeds[0].toJSON().description, /Nothing has been completed in the last 24 hours\./);
    assert.deepEqual(h.store.getPanel(pid())!.messageIds, [open.id, done.id]);
  });

  describe('a panel long enough to span several messages', () => {
    const longList = () => Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) }));
    const buttonIds = (m: { payload: any }) => m.payload.components.map((r: any) => r.toJSON()).flatMap((r: any) => r.components.map((c: any) => c.custom_id));

    /** The messages of the open flights (all but the last, which is the completed flights' panel). */
    const openMessages = () => channel().live.slice(0, -1);

    it('puts the buttons on every message of the open flights, not just the last, and none under the completed flights', async () => {
      h.jobs.sync(pid(), longList());
      await d.panels.refresh(pid());
      assert.ok(openMessages().length > 1, 'the list really is split over several messages');
      for (const m of openMessages()) assert.deepEqual(buttonIds(m), [`panel:reserve:${pid()}`, `panel:search:${pid()}`, `panel:backup:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`, `panel:list:${pid()}`]);
      assert.deepEqual(buttonIds(channel().live.at(-1)!), []);
    });

    it('keeps them there when the panel is edited in place', async () => {
      h.jobs.sync(pid(), longList());
      await d.panels.refresh(pid());
      const first = channel().live.map((m) => m.id);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      await settle();
      assert.deepEqual(channel().live.map((m) => m.id), first, 'edited, not reposted');
      for (const m of openMessages()) assert.deepEqual(buttonIds(m), [`panel:reserve:${pid()}`, `panel:search:${pid()}`, `panel:backup:${pid()}`, `panel:mine:${pid()}`, `panel:complete:${pid()}`, `panel:list:${pid()}`]);
      assert.deepEqual(buttonIds(channel().live.at(-1)!), []);
    });

    it('puts them on a message that was the last one of the open flights, and then no longer is', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      await d.panels.refresh(pid());
      h.jobs.sync(pid(), longList());
      await settle();
      assert.ok(openMessages().length > 1);
      for (const m of openMessages()) assert.equal(buttonIds(m).length, 6);
      assert.equal(buttonIds(channel().live.at(-1)!).length, 0);
    });
  });

  it('edits the same message in place when things change', async () => {
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
    const first = channel().live[0]!;
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
    await settle();
    assert.equal(channel().live.length, 2, 'no further message: the open flights and the completed ones');
    assert.ok(first.edits.length >= 1);
    assert.match(messageText(channel().live[0]!), new RegExp(`<@${USER_A.discordId}>`));
  });

  it("shows a reserver's name on the panel as soon as they reserve (event-driven)", async () => {
    h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC')]);
    await settle();
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [2], USER_B);
    await settle();
    assert.match(messageText(channel().live[0]!), new RegExp(`\`2\` EGKK → EGCC — <@${USER_B.discordId}>`));
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
    assert.equal(channel().live.length, 2);
    h.jobs.sync(pid(), Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) })));
    await settle();
    const many = channel().live.length;
    assert.ok(many > 2);
    h.jobs.sync(pid(), []);
    await settle();
    assert.equal(channel().live.length, 2);
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
      assert.equal(channel().live.length, 2);
      const replacement = channel().live[0]!;
      assert.notEqual(replacement.id, original.id);
      assert.deepEqual(h.store.getPanel(pid())!.messageIds, channel().live.map((m) => m.id));

      // and it did not fall into a failing loop: later changes edit the new message
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      await settle();
      assert.equal(channel().live.length, 2);
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
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK'), sj('b', 'EGKK-EGCC')]); // something changed, so there is an edit to make
      assert.equal(await d.panels.refresh(pid()), 'posted');
      assert.equal(channel().live.length, 2);
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

  describe('redraws that overlap', () => {
    /** Make the channel hold every new post until `release()` is called. */
    const holdPosts = () => {
      const ch = channel();
      const realSend = ch.send.bind(ch);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      ch.send = async (p: any) => {
        await gate;
        return realSend(p);
      };
      return { release, restore: () => (ch.send = realSend) };
    };

    it('never leave a second copy of the panel when several start at once', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      const results = await Promise.all([d.panels.refresh(pid()), d.panels.refresh(pid()), d.panels.refresh(pid())]);
      assert.equal(results[0], 'posted');
      assert.equal(channel().live.length, 2, 'one panel (the open flights and the completed ones), not two or three');
      assert.deepEqual(h.store.getPanel(pid())!.messageIds, channel().live.map((m) => m.id), 'and every message is one the bot knows about');
    });

    it('draw what changed while the first was under way, and share one redraw between the waiting requests', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      const hold = holdPosts();
      const first = d.panels.refresh(pid());
      await settle(10);
      h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_A);
      const second = d.panels.refresh(pid());
      const third = d.panels.refresh(pid());
      assert.strictEqual(second, third, 'asked twice while waiting, drawn once');
      hold.release();
      assert.equal(await first, 'posted');
      assert.equal(await second, 'updated');
      assert.equal(channel().live.length, 2);
      assert.match(messageText(channel().live[0]!), new RegExp(`<@${USER_A.discordId}>`), 'the reservation made meanwhile is on the panel');
    });

    it('remember a panel that was only half posted, so the next redraw clears it away', async () => {
      h.jobs.sync(pid(), Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) })));
      const ch = channel();
      const realSend = ch.send.bind(ch);
      let posts = 0;
      ch.send = async (p: any) => {
        if (++posts === 3) throw new Error('Discord hiccup');
        return realSend(p);
      };
      assert.equal(await d.panels.refresh(pid()), 'failed');
      const stray = [...ch.live];
      assert.equal(stray.length, 2, 'two messages got posted before it stopped');
      assert.deepEqual(h.store.getPanel(pid())!.messageIds, stray.map((m) => m.id), 'and both are remembered');

      ch.send = realSend;
      assert.equal(await d.panels.refresh(pid()), 'posted');
      assert.ok(stray.every((m) => m.deleted), 'the half panel was removed');
      assert.ok(ch.live.length > 2);
      assert.deepEqual(h.store.getPanel(pid())!.messageIds, ch.live.map((m) => m.id));
    });

    it('make deleting a panel wait for a redraw under way, so it cannot post the panel again afterwards', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
      const hold = holdPosts();
      const redraw = d.panels.refresh(pid());
      await settle(10);
      const deleting = d.panels.deleteMessages(h.store.getPanel(pid())!);
      await settle(10);
      hold.release();
      await Promise.all([redraw, deleting]);
      assert.equal(channel().live.length, 0, 'everything that was posted was removed');
    });
  });

  it('collapses a burst of changes into one redraw', async () => {
    const svc = new PanelService(h.store, h.jobs, silentLogger, () => T0, 30);
    svc.attach(d.client as unknown as Client);
    for (let i = 0; i < 5; i++) svc.schedule(pid());
    await settle(90);
    assert.equal(channel().live.length, 2, 'one panel (the open flights and the completed ones), not five');
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
