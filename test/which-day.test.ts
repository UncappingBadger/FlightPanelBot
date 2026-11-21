import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { etaCommand } from '../src/discord/commands/eta.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { JobError } from '../src/services/jobs.js';
import { HOUR, makeHarness, sj, T0, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;
let nextUser = 600000000000000000n;
/** A new person every time, so nothing one test leaves behind (a message cooldown, say) can reach another. */
const person = (name: string): FakeUser => new FakeUser(String(++nextUser), name);

/** A flight on the 11th, 12th and 13th November 2026 (T0 is 12:00Z on the 11th), all with the same flight number: each carries its day. */
const THREE_DAYS = () => [
  sj('d11', 'EGLL-EGKK', { flightNumber: 'SKY216-11NOV', availableFrom: T0 + 2 * HOUR, deadline: T0 + 10 * HOUR }),
  sj('d12', 'EGLL-EGKK', { flightNumber: 'SKY216-12NOV', availableFrom: T0 + 26 * HOUR, deadline: T0 + 34 * HOUR }),
  sj('d13', 'EGLL-EGKK', { flightNumber: 'SKY216-13NOV', availableFrom: T0 + 50 * HOUR, deadline: T0 + 58 * HOUR }),
  sj('once', 'EGKK-EGCC', { flightNumber: 'SKY329' }),
];

describe('a flight number that is flown on more than one day', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  let pid: number;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(person('alice'));
    bob = d.client.user(person('bob'));
    pid = h.panel.id;
    h.jobs.sync(pid, THREE_DAYS());
    h.store.setPilotId(alice.id, 1234, T0, 'Alice');
    h.store.setPilotId(bob.id, 5678, T0, 'Bob');
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const job = (code: string) => h.jobs.open(pid).find((v) => v.job.code === code)!;
  const holder = (code: string) => job(code).legs.map((l) => l.holder?.discordId ?? null);
  const session = (u: FakeUser) => h.store.getSession(u.id, h.clock.now);
  const press = async (user: FakeUser, customId: string) => {
    const f = fakeComponent(user, customId);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const buttons = (payload: any): Array<{ custom_id: string; label: string; disabled?: boolean }> =>
    (payload?.components ?? []).flatMap((r: any) => r.toJSON().components);
  const question = /is flown on more than one day\. Which one do you want to reserve\?/;

  describe('how the codes read, as the sheet gives them', () => {
    it('a number on one row is plain, and one on several rows carries its day', () => {
      assert.deepEqual(h.jobs.open(pid).map((v) => v.job.code).sort(), ['SKY216-11NOV', 'SKY216-12NOV', 'SKY216-13NOV', 'SKY329']);
    });
  });

  describe('asking which day', () => {
    it('asks, with the days and their routes, when the bare number could be any of several, and reserves nothing yet', async () => {
      await say(alice, 'SKY216');
      const t = alice.lastText;
      assert.match(t, /^\*\*SKY216\*\* is flown on more than one day\. Which one do you want to reserve\?\n/);
      assert.match(t, /• `SKY216-11NOV` · Wed 11 Nov · EGLL → EGKK · open/);
      assert.match(t, /• `SKY216-12NOV` · Thu 12 Nov · EGLL → EGKK · open/);
      assert.match(t, /• `SKY216-13NOV` · Fri 13 Nov · EGLL → EGKK · open/);
      assert.match(t, /Press a day below, or reply with the date \(like `21 Nov`\) or the full ID\. Days are Zulu \(UTC\), like the IDs\. Say `cancel` to stop\.$/);
      assert.deepEqual([holder('SKY216-11NOV'), holder('SKY216-12NOV'), holder('SKY216-13NOV')], [[null], [null], [null]]);
      assert.deepEqual([session(alice)?.step, session(alice)?.pendingText, session(alice)?.attempts], ['await_code', 'SKY216', 0], 'it is a question, not a wrong try');
    });

    it('has a button for each day, and one to cancel', async () => {
      await say(alice, 'reserve SKY216');
      const b = buttons(alice.last);
      assert.deepEqual(b.slice(0, 3).map((x) => x.label), ['Wed 11 Nov · EGLL → EGKK', 'Thu 12 Nov · EGLL → EGKK', 'Fri 13 Nov · EGLL → EGKK']);
      assert.deepEqual(b.slice(0, 3).map((x) => x.custom_id), [11, 12, 13].map((n) => `dm:pick:${job(`SKY216-${n}NOV`).job.id}`));
      assert.equal(b.at(-1)!.custom_id, 'dm:cancel');
      assert.ok(b.slice(0, 3).every((x) => !x.disabled));
    });

    it('is asked the same way with the number written as the pilot likes (a space needs the word that says what to do), and in a longer sentence', async () => {
      for (const text of ['sky216', 'reserve Sky 216', 'please reserve SKY216 for me']) {
        const who = person('p');
        h.store.setPilotId(who.id, 9, T0, 'P');
        await say(who, text);
        assert.match(who.lastText, question, text);
      }
    });

    it('does not ask for a number that is flown once, or for a day that is named', async () => {
      await say(alice, 'SKY329');
      assert.match(alice.lastText, /^✅ \*\*SKY329\*\*/);
      await say(alice, 'sky216-12nov');
      assert.match(alice.lastText, /^✅ \*\*SKY216-12NOV\*\*/);
      assert.deepEqual(holder('SKY216-12NOV'), [alice.id]);
    });

    it('does not ask when only one of that number is open: the bare number is that flight', async () => {
      h.jobs.sync(pid, [THREE_DAYS()[0]!, THREE_DAYS()[3]!]); // the other two days have left the schedule
      await say(alice, 'SKY216');
      assert.match(alice.lastText, /^✅ \*\*SKY216-11NOV\*\*/);
    });

    it('counts only open flights: a day already flown, or past its deadline, is not one of the choices', async () => {
      h.jobs.sync(pid, [
        THREE_DAYS()[0]!,
        sj('d12', 'EGLL-EGKK', { flightNumber: 'SKY216-12NOV', availableFrom: T0 + 26 * HOUR, deadline: T0 + 34 * HOUR, completed: true }),
        THREE_DAYS()[2]!,
        THREE_DAYS()[3]!,
      ]);
      await say(alice, 'SKY216');
      assert.doesNotMatch(alice.lastText, /12NOV/);
      assert.match(alice.lastText, /SKY216-11NOV/);
      assert.match(alice.lastText, /SKY216-13NOV/);
    });

    it('says whether each day is open or taken, and by the time it asks the day taken is still there to see', async () => {
      h.jobs.reserve(job('SKY216-12NOV').job.id, [1], { discordId: bob.id, username: 'bob' });
      await say(alice, 'SKY216');
      assert.match(alice.lastText, /SKY216-12NOV` · Thu 12 Nov · EGLL → EGKK · taken/);
      assert.match(alice.lastText, /SKY216-11NOV` · Wed 11 Nov · EGLL → EGKK · open/);
    });
  });

  describe('answering with a button', () => {
    it('reserves that day, and only that day, as if its own ID had been typed', async () => {
      await say(alice, 'SKY216');
      const calls = await press(alice, `dm:pick:${job('SKY216-12NOV').job.id}`);
      assert.equal(calls.updates[0].content, 'Okay: **SKY216-12NOV** (Thu 12 Nov).');
      assert.deepEqual(calls.updates[0].components, []);
      assert.match(alice.lastText, /^✅ \*\*SKY216-12NOV\*\* \(EGLL → EGKK\) is reserved for you\./);
      assert.deepEqual([holder('SKY216-11NOV'), holder('SKY216-12NOV'), holder('SKY216-13NOV')], [[null], [alice.id], [null]]);
      assert.equal(session(alice), null);
    });

    it('says a day that was taken in the meantime is taken', async () => {
      await say(alice, 'SKY216');
      h.jobs.reserve(job('SKY216-13NOV').job.id, [1], { discordId: bob.id, username: 'bob' });
      await press(alice, `dm:pick:${job('SKY216-13NOV').job.id}`);
      assert.match(alice.lastText, /already taken by <@\d+>/);
      assert.deepEqual(holder('SKY216-13NOV'), [bob.id]);
    });

    it('asks the legs question when the day chosen has several legs', async () => {
      h.jobs.sync(pid, [
        sj('m11', 'EGLL-EGKK-EGCC', { flightNumber: 'SKY500-11NOV', availableFrom: T0 + 2 * HOUR, deadline: T0 + 10 * HOUR }),
        sj('m12', 'EGLL-EGKK-EGCC', { flightNumber: 'SKY500-12NOV', availableFrom: T0 + 26 * HOUR, deadline: T0 + 34 * HOUR }),
      ]);
      await say(alice, 'SKY500');
      await press(alice, `dm:pick:${job('SKY500-12NOV').job.id}`);
      assert.match(alice.lastText, /\*\*SKY500-12NOV\*\* has 2 legs\. Are you flying all of them, or just some\?/);
      assert.equal(session(alice)?.step, 'await_mode');
    });

    it('turns away a button from a question that has closed, or that someone else started', async () => {
      await say(alice, 'SKY216');
      const stale = `dm:pick:${job('SKY216-12NOV').job.id}`;
      await say(alice, 'SKY329'); // a new ID ends the question
      const calls = await press(alice, stale);
      assert.match(calls.updates[0].content, /^That question has closed\./);
      assert.deepEqual(holder('SKY216-12NOV'), [null]);
      const calls2 = await press(bob, stale); // bob never asked
      assert.match(calls2.updates[0].content, /^That question has closed\./);
      assert.deepEqual(holder('SKY216-12NOV'), [null]);
    });

    it('refuses a button for a flight with another number', async () => {
      await say(alice, 'SKY216');
      const calls = await press(alice, `dm:pick:${job('SKY329').job.id}`);
      assert.match(calls.updates[0].content, /^That question has closed\./);
      assert.deepEqual(holder('SKY329'), [null]);
    });

    it('closes the conversation with Cancel', async () => {
      await say(alice, 'SKY216');
      const calls = await press(alice, 'dm:cancel');
      assert.equal(calls.updates[0].content, 'Okay, cancelled.');
      assert.equal(session(alice), null);
    });
  });

  describe('answering by typing', () => {
    it('takes the day as a date, in the ways pilots write one', async () => {
      const cases: Array<[string, string]> = [['12 Nov', 'SKY216-12NOV'], ['12NOV', 'SKY216-12NOV'], ['Thu 12 Nov', 'SKY216-12NOV'], ['12/11', 'SKY216-12NOV'], ['nov 13', 'SKY216-13NOV'], ['tomorrow', 'SKY216-12NOV'], ['today', 'SKY216-11NOV']];
      for (const [reply, code] of cases) {
        const who = person('p');
        h.store.setPilotId(who.id, 9, T0, 'P');
        await say(who, 'SKY216');
        await say(who, reply);
        assert.match(who.lastText, new RegExp(`^✅ \\*\\*${code}\\*\\*`), `${reply} -> ${who.lastText}`);
        assert.equal(h.jobs.open(pid).find((v) => v.job.code === code)!.legs[0]!.holder?.discordId, who.id, reply);
        h.jobs.release(job(code).job.id, who.id, [1]);
      }
    });

    it('takes the full ID, and a different flight, as the answer too', async () => {
      await say(alice, 'SKY216');
      await say(alice, 'SKY216-13NOV');
      assert.deepEqual(holder('SKY216-13NOV'), [alice.id]);
      await say(bob, 'SKY216');
      await say(bob, 'SKY329');
      assert.deepEqual(holder('SKY329'), [bob.id]);
      assert.equal(session(bob), null);
    });

    it('says so, and asks again, when the date is not a day of that flight', async () => {
      await say(alice, 'SKY216');
      await say(alice, '20 Nov');
      assert.match(alice.dms.at(-2)!.content, /^\*\*SKY216\*\* isn't flown on Fri 20 Nov, or not on a day that can be booked\.$/);
      assert.match(alice.lastText, question, 'and the question is asked again');
      assert.equal(session(alice)?.attempts, 1);
      assert.deepEqual(holder('SKY216-11NOV'), [null]);
      await say(alice, '13 Nov');
      assert.deepEqual(holder('SKY216-13NOV'), [alice.id]);
    });

    it('closes after a few days that do not fit, as it does after a few IDs that do not', async () => {
      await say(alice, 'SKY216');
      for (let i = 0; i < 5; i++) await say(alice, '20 Nov');
      assert.match(alice.lastText, /^That's a few days I couldn't use, so I've closed this\. Press \*\*Reserve\*\* on the panel to start again\.$/);
      assert.equal(session(alice), null);
    });
  });

  describe('days the panel does not list yet', () => {
    it('shows them, but cannot be pressed, and still asks when only one day can be booked', async () => {
      h.store.updatePanel(pid, { showDays: 1 });
      await say(alice, 'SKY216');
      assert.match(alice.lastText, /SKY216-11NOV` · Wed 11 Nov · EGLL → EGKK · open/);
      assert.match(alice.lastText, /SKY216-13NOV` · Fri 13 Nov · EGLL → EGKK · not open for booking yet/);
      assert.deepEqual(buttons(alice.last).slice(0, 3).map((x) => !!x.disabled), [false, true, true].map((x, i) => (i === 0 ? false : x)));
    });

    it('does not ask when no day can be booked yet: it answers for the soonest, as for any flight too far ahead', async () => {
      h.jobs.sync(pid, [
        sj('far1', 'EGLL-EGKK', { flightNumber: 'SKY700-20NOV', availableFrom: T0 + 9 * DAY, deadline: T0 + 9 * DAY + 8 * HOUR }),
        sj('far2', 'EGLL-EGKK', { flightNumber: 'SKY700-21NOV', availableFrom: T0 + 10 * DAY, deadline: T0 + 10 * DAY + 8 * HOUR }),
        THREE_DAYS()[3]!, // something else is open, so the panel is not empty
      ]);
      await say(alice, 'reserve SKY700');
      assert.doesNotMatch(alice.lastText, question);
      assert.match(alice.lastText, /SKY700-20NOV/);
      assert.match(alice.lastText, /ahead/);
      assert.deepEqual(holder('SKY700-20NOV'), [null]);
    });
  });

  describe('standing by as backup', () => {
    beforeEach(() => {
      for (const day of [11, 12, 13]) h.jobs.reserve(job(`SKY216-${day}NOV`).job.id, [1], { discordId: bob.id, username: 'bob' });
    });

    it('asks which day to stand by for, and puts the person down for the one chosen', async () => {
      await say(alice, 'backup SKY216');
      assert.match(alice.lastText, /^\*\*SKY216\*\* is flown on more than one day\. Which one do you want to stand by for\?/);
      assert.match(alice.lastText, /SKY216-12NOV` · Thu 12 Nov · EGLL → EGKK · taken/);
      assert.equal(session(alice)?.purpose, 'backup');
      await press(alice, `dm:pick:${job('SKY216-12NOV').job.id}`);
      assert.match(alice.lastText, /^🛟 You're down as backup for \*\*SKY216-12NOV\*\*/);
      assert.equal(job('SKY216-12NOV').backup?.discordId, alice.id);
      assert.equal(job('SKY216-11NOV').backup, null);
    });

    it('takes a typed date for backup too', async () => {
      await say(alice, 'backup SKY216');
      await say(alice, '13 Nov');
      assert.equal(job('SKY216-13NOV').backup?.discordId, alice.id);
    });

    it('says a day that has a free leg cannot be stood by for, as for any flight', async () => {
      h.jobs.release(job('SKY216-11NOV').job.id, bob.id, [1]);
      await say(alice, 'backup SKY216');
      assert.match(alice.lastText, /SKY216-11NOV` · Wed 11 Nov · EGLL → EGKK · still has a free leg/);
      await say(alice, '11 Nov');
      assert.match(alice.lastText, /^SKY216-11NOV still has a leg nobody has/);
    });
  });

  describe('the first time, before the FsHub pilot ID is known', () => {
    it('asks for the ID first, and then asks which day', async () => {
      const carol = d.client.user(person('carol'));
      await say(carol, 'SKY216');
      assert.match(carol.lastText, /First, what is your FsHub pilot ID\?/);
      await say(carol, '4321');
      assert.match(carol.lastText, question);
      assert.equal(session(carol)?.pendingText, 'SKY216');
      await say(carol, '12 Nov');
      assert.match(carol.lastText, /^✅ \*\*SKY216-12NOV\*\*/);
    });
  });

  describe('several IDs in one message', () => {
    it('reserves the flights that are one flight, says the number flown on several days was not guessed, and asks when it is sent alone', async () => {
      await say(alice, 'SKY329, SKY216');
      assert.match(alice.lastText, /✅ \*\*SKY329\*\*/);
      assert.match(alice.lastText, /↪️ \*\*SKY216\*\* is flown on more than one day \(`SKY216-11NOV`, `SKY216-12NOV` and `SKY216-13NOV`\)\. Send it on its own and I'll ask which day\./);
      assert.deepEqual(holder('SKY329'), [alice.id]);
      assert.deepEqual(holder('SKY216-11NOV'), [null]);
      assert.equal(session(alice)?.step, 'await_code', 'the conversation stays open for it');
      await say(alice, 'SKY216');
      assert.match(alice.lastText, question);
    });

    it('does not mistake the same number twice for two flights', async () => {
      await say(alice, 'SKY216, sky216');
      assert.match(alice.lastText, question, 'one number, so one question');
    });
  });

  describe('looking a flight up', () => {
    it('finds the old dated ID of a flight whose day has left its ID, but only on its own day', () => {
      h.jobs.sync(pid, [sj('d11', 'EGLL-EGKK', { flightNumber: 'SKY216', availableFrom: T0 + 2 * HOUR, deadline: T0 + 10 * HOUR }), THREE_DAYS()[3]!]);
      const panel = h.store.getPanel(pid)!;
      assert.equal(h.jobs.findByCode(panel, 'SKY216')?.job.code, 'SKY216');
      assert.equal(h.jobs.findByCode(panel, 'sky216-11nov')?.job.code, 'SKY216', 'the dated ID it had still finds it');
      assert.equal(h.jobs.findByCode(panel, 'SKY216-12NOV'), null, 'another day is not it');
      assert.equal(h.jobs.findByCode(panel, 'SKY329-11NOV'), null);
    });

    it('lists the choices soonest first, and none for a whole ID or for a number flown once', () => {
      const panel = h.store.getPanel(pid)!;
      assert.deepEqual(h.jobs.datedChoices(panel, 'SKY216').map((v) => v.job.code), ['SKY216-11NOV', 'SKY216-12NOV', 'SKY216-13NOV']);
      assert.deepEqual(h.jobs.datedChoices(panel, 'SKY216-11NOV'), []);
      assert.deepEqual(h.jobs.datedChoices(panel, 'SKY329'), []);
      assert.deepEqual(h.jobs.datedChoices(panel, 'NOPE1'), []);
      assert.deepEqual(h.jobs.datedChoices(panel, ''), []);
    });

    it('reports a number flown on several days from findSeveral, with the days, and the others as before', () => {
      const panel = h.store.getPanel(pid)!;
      const found = h.jobs.findSeveral(panel, 'SKY329, SKY216 and ZZZ-9');
      assert.deepEqual(found.items.map((i) => i.kind), ['flight', 'several', 'unknown']);
      const several = found.items[1]!;
      assert.ok(several.kind === 'several');
      assert.deepEqual(several.views.map((v) => v.job.code), ['SKY216-11NOV', 'SKY216-12NOV', 'SKY216-13NOV']);
    });
  });

  describe('an admin freeing someone', () => {
    it('has to say which day, and is told the choices, rather than being told the flight is not there', () => {
      const panel = h.store.getPanel(pid)!;
      assert.throws(() => h.jobs.adminRelease(panel, 'SKY216'), (e: unknown) => e instanceof JobError && /^SKY216 is flown on more than one day \(SKY216-11NOV, SKY216-12NOV and SKY216-13NOV\)\. Give the one you mean, with its day\.$/.test(e.message));
      h.jobs.reserve(job('SKY216-12NOV').job.id, [1], { discordId: bob.id, username: 'bob' });
      assert.equal(h.jobs.adminRelease(panel, 'SKY216-12NOV').length, 1);
      assert.deepEqual(holder('SKY216-12NOV'), [null]);
    });
  });

  describe('/eta', () => {
    it('names the days instead of saying it does not know the flight', async () => {
      h.store.updatePanel(pid, { liveTracking: true });
      (d.ctx as { etas: unknown }).etas = { forPanel: () => new Map(), airborne: () => [] };
      const f = fakeInteraction({ options: { flight: 'SKY216' } });
      await etaCommand.execute(d.ctx, f.i);
      assert.equal(String(f.calls.edits.at(-1).content), '**SKY216** is flown on more than one day: `SKY216-11NOV`, `SKY216-12NOV`, `SKY216-13NOV`. Ask about one of them, like `/eta flight:SKY216-11NOV`.');
    });
  });
});
