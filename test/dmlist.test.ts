import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { GUILD, HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeComponent, fakeDm, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

describe('asking the bot for your flights in a DM', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const press = async (user: FakeUser, customId: string, o: { values?: string[]; guildId?: string | null } = {}) => {
    const f = fakeComponent(user, customId, o);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const jobId = (panelId: number, key: string) => h.store.listJobs(panelId).find((j) => j.sourceKey === key)!.id;
  const second = () => {
    const other = h.store.createPanel({ guildId: GUILD, name: 'Other Air', prefix: 'OTH', channelId: '800000000000000009', now: T0 });
    h.jobs.sync(other.id, [sj('o', 'KBOS-KORD')]);
    return other;
  };

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK'), sj('m', 'EGKK-EGCC-EGPH'), sj('free', 'EGCC-EGLL')]);
    h.jobs.reserve(jobId(pid(), 'a'), [1], USER_B);
    h.jobs.reserve(jobId(pid(), 'm'), [1, 2], USER_B);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('answers with the flights you hold, the same as under the panel, with a menu to give them back', async () => {
    await say(bob, 'flights');
    assert.equal(bob.dms.length, 1);
    const dm = bob.dms[0];
    assert.match(dm.content, /^\*\*Test Air\*\*\n\*\*Your flights\*\*\n\*\*TST-001\*\* · EGLL → EGKK · ⏰ complete by <t:\d+:f> \(<t:\d+:R>\)\n\*\*TST-002\*\* · leg 1: EGKK → EGCC, leg 2: EGCC → EGPH · ⏰/);
    assert.doesNotMatch(dm.content, /TST-003/, 'a flight you do not hold is not listed');
    assert.match(dm.content, /Pick any you can no longer fly to give them back\./);
    assert.match(dm.content, /Your FsHub pilot ID is shown as .*1002.*\./);
    assert.deepEqual(dm.allowedMentions, { parse: [] });
    const menu = dm.components[0].toJSON().components[0];
    assert.equal(menu.custom_id, `panel:release:${pid()}`);
    assert.deepEqual(menu.options.map((o: any) => o.value), [`${jobId(pid(), 'a')}:1`, `${jobId(pid(), 'm')}:1`, `${jobId(pid(), 'm')}:2`]);

    const button = await press(bob, `panel:mine:${pid()}`);
    const underPanel = button.edits[0].content as string;
    assert.ok(underPanel.startsWith(dm.content.split('\n').slice(1).join('\n').split('\n\nPick any')[0]!), 'one and the same list');
  });

  it('understands the usual ways of asking', async () => {
    for (const ask of ['flights', 'Flights', 'my flights', 'MY FLIGHTS?', 'list', 'mine', 'show my flights', 'list my flights', 'flight list', 'my reservations', 'my bookings', ' my flight ', 'get me my flights!']) {
      bob.dms.length = 0;
      await say(bob, ask);
      assert.equal(bob.dms.length, 1, ask);
      assert.match(bob.lastText, /Your flights/, ask);
    }
  });

  it('does not take other messages for a request: a flight ID, an ID that merely contains the word, or a longer sentence', async () => {
    for (const other of ['TST-001', 'flights to EGLL', 'FLIGHTSX', 'list of flights please', 'what flights do I have']) {
      bob.dms.length = 0;
      await say(bob, other);
      assert.doesNotMatch(bob.dms.map((m: any) => m.content).join('\n'), /Your flights/, other);
    }
  });

  it('says so, and how to start, when you have no flights', async () => {
    await say(alice, 'flights');
    assert.match(alice.lastText, /^You haven't reserved any flights right now\. Press \*\*Reserve\*\* on a flight panel in your server to pick one\./);
    assert.deepEqual(alice.dms[0].components ?? [], [], 'nothing to pick from');
  });

  it("does not list flights you have already completed, or other people's", async () => {
    h.jobs.complete(jobId(pid(), 'm'), USER_B.discordId);
    await say(bob, 'flights');
    assert.doesNotMatch(bob.lastText, /TST-002/);
    assert.match(bob.lastText, /TST-001/);
    await say(alice, 'flights');
    assert.match(alice.lastText, /haven't reserved any flights/);
  });

  it('lists flights you are backup for, with the way to stand down', async () => {
    h.jobs.addBackup(jobId(pid(), 'a'), USER_A);
    await say(alice, 'my flights');
    assert.match(alice.lastText, /\*\*TST-001\*\* · EGLL → EGKK · ⏰ complete by[^\n]*\n↳ 🛟 You're the backup, if the pilot who has it can't fly it\./);
    const menu = alice.dms[0].components[0].toJSON().components[0];
    assert.deepEqual(menu.options.map((o: any) => o.value), [`b:${jobId(pid(), 'a')}`]);
    assert.equal(menu.placeholder, 'Release a flight or stand down…');
  });

  it('sends one message for each panel you have flights on, in order, each with its own menu', async () => {
    const other = second();
    h.jobs.reserve(jobId(other.id, 'o'), [1], USER_B);
    await say(bob, 'flights');
    assert.equal(bob.dms.length, 2);
    assert.match(bob.dms[0].content, /^\*\*Other Air\*\*\n\*\*Your flights\*\*\n\*\*OTH-001\*\* · KBOS → KORD/);
    assert.match(bob.dms[1].content, /^\*\*Test Air\*\*\n\*\*Your flights\*\*\n\*\*TST-001\*\*/);
    assert.deepEqual(bob.dms.map((m: any) => m.components[0].toJSON().components[0].custom_id), [`panel:release:${other.id}`, `panel:release:${pid()}`]);
    assert.doesNotMatch(bob.dms[0].content, /FsHub pilot ID is shown/, 'the note about your pilot ID comes once, at the end');
    assert.match(bob.dms[1].content, /FsHub pilot ID is shown/);
  });

  it('gives a flight back from the menu in the DM, and the panel is updated', async () => {
    await say(bob, 'flights');
    const calls = await press(bob, `panel:release:${pid()}`, { values: [`${jobId(pid(), 'a')}:1`], guildId: null });
    assert.match(calls.edits[0].content, /^Released: TST-001 leg 1\./);
    assert.equal(h.jobs.open(pid()).find((v) => v.job.sourceKey === 'a')!.legs[0]!.holder, null);
    await say(bob, 'flights');
    assert.doesNotMatch(bob.lastText, /TST-001/);
  });

  it('works while a Reserve conversation is open, and leaves it open', async () => {
    await press(alice, `panel:reserve:${pid()}`);
    assert.ok(h.store.getSession(alice.id, h.clock.now), 'a conversation is open');
    await say(alice, 'flights');
    assert.match(alice.lastText, /haven't reserved any flights/);
    assert.ok(h.store.getSession(alice.id, h.clock.now), 'and it is still open');
    await say(alice, 'TST-003');
    assert.match(alice.lastText, /TST-003.*is reserved for you/);
  });

  it('keeps a very long list inside what one message can carry, and says how many more there are', async () => {
    h.jobs.sync(pid(), Array.from({ length: 60 }, (_, i) => sj(`x${i}`, 'EGLL-EGKK', { deadline: T0 + (100 + i) * HOUR })));
    for (const v of h.jobs.open(pid())) if (v.legs[0]!.holder === null && !v.legs[0]!.sheetHolder) h.jobs.reserve(v.job.id, [1], USER_B);
    await say(bob, 'flights');
    const text = bob.dms[0].content as string;
    assert.ok(text.length < 2000, `${text.length} characters`);
    assert.match(text, /…and \d+ more\./);
    assert.equal(bob.dms[0].components[0].toJSON().components[0].options.length, 25, 'the menu keeps what Discord allows');
  });

  describe('when each flight opens and closes', () => {
    const times = (opens: number | null, closes: number | null) =>
      h.jobs.sync(pid(), [
        sj('a', 'EGLL-EGKK', { availableFrom: opens, deadline: closes }),
        sj('m', 'EGKK-EGCC-EGPH', { availableFrom: opens, deadline: closes }),
        sj('free', 'EGCC-EGLL'),
      ]);
    const stamp = (ms: number) => Math.floor(ms / 1000);
    const line = (code: string, text: string) => text.split('\n').find((l) => l.startsWith(`**${code}**`))!;

    it('shows both the opening and the closing time, as the panel does, for a flight that has not opened yet', async () => {
      times(T0 + 3 * HOUR, T0 + 20 * HOUR);
      await say(bob, 'flights');
      assert.equal(
        line('TST-001', bob.lastText),
        `**TST-001** · EGLL → EGKK · 🕐 opens <t:${stamp(T0 + 3 * HOUR)}:f> (<t:${stamp(T0 + 3 * HOUR)}:R>) · ⏰ complete by <t:${stamp(T0 + 20 * HOUR)}:f> (<t:${stamp(T0 + 20 * HOUR)}:R>)`,
      );
      assert.match(line('TST-002', bob.lastText), /^\*\*TST-002\*\* · leg 1: EGKK → EGCC, leg 2: EGCC → EGPH · 🕐 opens <t:\d+:f> \(<t:\d+:R>\) · ⏰ complete by /);
    });

    it('says "opened" once the window is open, and still gives the closing time', async () => {
      times(T0 - 5 * HOUR, T0 + 20 * HOUR);
      await say(bob, 'flights');
      assert.match(line('TST-001', bob.lastText), /· 🕐 opened <t:\d+:f> \(<t:\d+:R>\) · ⏰ complete by <t:\d+:f> \(<t:\d+:R>\)$/);
    });

    it('gives only what a flight has: a closing time alone, an opening time alone, or neither', async () => {
      times(null, T0 + 20 * HOUR);
      await say(bob, 'flights');
      assert.match(line('TST-001', bob.lastText), /^\*\*TST-001\*\* · EGLL → EGKK · ⏰ complete by /);
      assert.doesNotMatch(line('TST-001', bob.lastText), /🕐/);
      times(T0 + HOUR, null);
      await say(bob, 'flights');
      assert.match(line('TST-001', bob.lastText), /^\*\*TST-001\*\* · EGLL → EGKK · 🕐 opens <t:\d+:f> \(<t:\d+:R>\)$/);
      times(null, null);
      await say(bob, 'flights');
      assert.equal(line('TST-001', bob.lastText), '**TST-001** · EGLL → EGKK');
    });

    it('is the same under the My flights button', async () => {
      times(T0 + 3 * HOUR, T0 + 20 * HOUR);
      await say(bob, 'flights');
      const button = await press(bob, `panel:mine:${pid()}`);
      assert.equal(line('TST-001', button.edits[0].content), line('TST-001', bob.lastText));
    });

    it('shows both times on the flights you are backup for', async () => {
      times(T0 + 3 * HOUR, T0 + 20 * HOUR);
      h.jobs.addBackup(jobId(pid(), 'a'), USER_A);
      await say(alice, 'flights');
      assert.match(alice.lastText, /\*\*TST-001\*\* · EGLL → EGKK · 🕐 opens <t:\d+:f> \(<t:\d+:R>\) · ⏰ complete by <t:\d+:f> \(<t:\d+:R>\)\n↳ 🛟/);
    });
  });

  it('is mentioned in the pointer people get when they message the bot out of the blue', async () => {
    await say(alice, 'hello there');
    assert.match(alice.lastText, /Send me `flights` any time to see the flights you have, or `my contributions` to see what your completed flights made for the airline\./);
  });
});
