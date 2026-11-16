import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { JobError } from '../src/services/jobs.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;
/** What a pilot is told about a flight beyond the panel's days. */
const tooFar = (code: string, days = 7, verb = 'book') => `You can't ${verb} flights more than ${days} day${days === 1 ? '' : 's'} ahead, and **${code}** starts further off than that. It will be open for booking once it comes within ${days} day${days === 1 ? '' : 's'}.`;
const starting = (key: string, chain: string, inDays: number, over: Parameters<typeof sj>[2] = {}) => sj(key, chain, { availableFrom: T0 + inDays * DAY, deadline: T0 + (inDays + 1) * DAY, ...over });

/**
 * A panel lists the flights open now or starting within its days. A pilot can only reach what it lists: a flight beyond that
 * cannot be reserved or stood by for, however the pilot got hold of its ID (typing it, guessing the next number, an old
 * conversation). Reported as an exploit: it used to be possible to reserve any open flight by its ID.
 */
describe("a flight beyond the panel's days cannot be reached by a pilot", () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  let pid: number;
  // TST-001 is the far one, on purpose: it is the first open flight, which is what an "example ID" would be taken from.
  const FAR = 'TST-001';
  const NEAR = 'TST-002';
  const WEEK = 'TST-003'; // exactly 7 days off: inside
  const idOf = (code: string) => h.store.listJobs(pid).find((j) => j.code === code)!.id;
  const holderOf = (code: string, leg = 1) => h.store.getJobView(idOf(code))!.legs[leg - 1]!.holder?.discordId ?? null;
  const panel = () => h.store.getPanel(pid)!;
  // The far flight has the soonest deadline of the three, so it is first among the open flights, which is where an example ID would come from.
  const jobs = () => [starting('far', 'EGLL-EGKK', 10), sj('near', 'EGKK-EGCC', { deadline: T0 + 30 * DAY }), starting('week', 'EGCC-EGPH', 7, { deadline: T0 + 40 * DAY })];

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.jobs.sync(pid, jobs());
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const handlerFor = (customId: string) => componentHandlers.find((x) => x.prefix === customId.split(':')[0])!;
  const press = async (user: FakeUser, customId: string) => {
    const f = fakeComponent(user, customId, {});
    await handlerFor(customId).handle(d.ctx, f.i);
    return f.calls;
  };
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const session = (user: FakeUser) => h.store.getSession(user.id, h.clock.now);

  describe('what is listed', () => {
    it('is the flights open now or starting within the days, the end of the last day included', () => {
      assert.deepEqual(h.jobs.listed(panel()).map((v) => v.job.code), [NEAR, WEEK]);
      h.store.updatePanel(pid, { showDays: 2 });
      assert.deepEqual(h.jobs.listed(panel()).map((v) => v.job.code), [NEAR]);
      h.store.updatePanel(pid, { showDays: 7 });
      h.clock.advance(4 * DAY);
      assert.deepEqual(h.jobs.listed(panel()).map((v) => v.job.code), [FAR, NEAR, WEEK], 'the far flight comes within the days as time passes');
    });

    it('leaves the far flight open in the database: only what a pilot can reach is limited', () => {
      assert.deepEqual(h.jobs.open(pid).map((v) => v.job.code), [FAR, NEAR, WEEK]);
    });
  });

  describe('typing an ID', () => {
    it('is listed however it is written, or is not when it is beyond the days', () => {
      for (const typed of ['TST-001', 'tst001', 'TST 001', 'tst1', '1']) {
        const view = h.jobs.findByCode(panel(), typed);
        assert.equal(view?.job.code, FAR, typed);
        assert.equal(h.jobs.isListed(panel(), view!), false, typed);
      }
      for (const typed of ['TST-002', 'tst002', 'TST 002', 'tst2', '2']) {
        const view = h.jobs.findByCode(panel(), typed);
        assert.equal(view?.job.code, NEAR, typed);
        assert.equal(h.jobs.isListed(panel(), view!), true, typed);
      }
      assert.equal(h.jobs.isListed(panel(), h.jobs.findByCode(panel(), 'TST-003')!), true, 'exactly 7 days off is inside');
    });

    it('is still found by admins, who release people from flights whatever their days', () => {
      assert.equal(h.jobs.findByCode(panel(), 'TST-001')?.job.code, FAR);
    });

    it('is answered by saying you cannot book that far ahead, with the days the admin set, and the conversation goes on', async () => {
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, FAR);
      assert.equal(alice.lastText, `${tooFar(FAR)}\nSend a different flight ID, or say \`cancel\`.`);
      assert.doesNotMatch(alice.lastText, /can't find/, 'it does not read as though something is wrong with the ID');
      assert.equal(holderOf(FAR), null);
      assert.equal(session(alice)?.attempts, 1);
      await say(alice, NEAR);
      assert.match(alice.lastText, /^✅ \*\*TST-002\*\*/);
      assert.equal(holderOf(NEAR), USER_A.discordId);
    });

    it('still says an ID that does not exist is not found', async () => {
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, 'TST-099');
      assert.match(alice.lastText, /^I can't find an open flight with the ID `TST-099`\. IDs look like `TST-002` and are listed on the panel\./);
    });

    it('closes the conversation after the usual number of tries, as for any other ID', async () => {
      await press(alice, `panel:reserve:${pid}`);
      for (let i = 0; i < 5; i++) await say(alice, FAR);
      assert.equal(alice.lastText, `${tooFar(FAR)}\nThat's a few flights I couldn't use, so I've closed this. Press **Reserve** on the panel to start again.`);
      assert.equal(session(alice), null);
      assert.equal(holderOf(FAR), null);
    });

    it('does not give away the ID of a flight beyond the days as the example', async () => {
      await press(alice, `panel:reserve:${pid}`);
      assert.match(alice.lastText, /for example `TST-002`/);
      assert.doesNotMatch(alice.lastText, /TST-001/);
    });

    it('is allowed once the flight comes within the days', async () => {
      h.clock.advance(4 * DAY);
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, FAR);
      assert.match(alice.lastText, /^✅ \*\*TST-001\*\*/);
      assert.equal(holderOf(FAR), USER_A.discordId);
    });

    it('follows the days the admin chose: fewer days takes a flight back out of reach, more brings it in', async () => {
      h.store.updatePanel(pid, { showDays: 1 });
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, WEEK);
      assert.equal(alice.lastText, `${tooFar(WEEK, 1)}\nSend a different flight ID, or say \`cancel\`.`, 'and the one day is said in the singular');
      h.store.updatePanel(pid, { showDays: 3 });
      await say(alice, WEEK);
      assert.match(alice.lastText, /^You can't book flights more than 3 days ahead, and \*\*TST-003\*\* starts further off than that\. It will be open for booking once it comes within 3 days\./);
      h.store.updatePanel(pid, { showDays: 7 });
      await say(alice, WEEK);
      assert.match(alice.lastText, /^✅ \*\*TST-003\*\*/);
    });
  });

  describe('the Reserve button', () => {
    it('says there is nothing to reserve when every open flight is beyond the days', async () => {
      h.jobs.sync(pid, [starting('far', 'EGLL-EGKK', 10), starting('further', 'EGKK-EGCC', 20)]);
      await assert.rejects(press(alice, `panel:reserve:${pid}`), /There are no open flights to reserve right now/);
      assert.equal(session(alice), null, 'no conversation was started');
      assert.equal(alice.dms.length, 0);
    });
  });

  describe('a conversation that was already open', () => {
    beforeEach(() => {
      h.jobs.sync(pid, [...jobs(), starting('multi', 'EGLL-EGKK-EGCC-EGPH', 5, { deadline: T0 + 50 * DAY })]);
    });

    it('cannot reserve a flight that the admin has since moved beyond the days', async () => {
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, 'TST-004');
      assert.match(alice.lastText, /has 3 legs/);
      h.store.updatePanel(pid, { showDays: 2 });
      const calls = await press(alice, 'dm:all');
      assert.equal(calls.updates[0].content, `${tooFar('TST-004', 2)}\nPress **Reserve** on the panel to try another flight.`);
      assert.deepEqual([1, 2, 3].map((leg) => holderOf('TST-004', leg)), [null, null, null]);
      assert.equal(session(alice), null);
    });

    it('an old All legs button cannot be used on the flight asked for afterwards, which was beyond the days', async () => {
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, 'TST-004'); // the multi-leg flight, with its All legs button
      await press(alice, `panel:reserve:${pid}`); // a new conversation, which leaves that button behind
      await say(alice, FAR); // a flight beyond the days: the conversation is about no flight
      assert.equal(session(alice)?.jobId, null);
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /^That conversation has closed\./);
      assert.deepEqual([FAR, 'TST-004'].map((code) => holderOf(code)), [null, null]);
    });

    it('still works while the flight is listed', async () => {
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, 'TST-004');
      const calls = await press(alice, 'dm:all');
      assert.match(calls.updates[0].content, /^✅ \*\*TST-004\*\*: you've got legs 1/);
    });
  });

  describe('the reservation itself', () => {
    it('refuses a flight beyond the days, whatever called it, and leaves it free', () => {
      assert.throws(
        () => h.jobs.reserve(idOf(FAR), [1], USER_A),
        (e: unknown) => e instanceof JobError && e.code === 'NOT_FOUND' && e.message === tooFar(FAR),
      );
      assert.equal(holderOf(FAR), null);
    });

    it('takes a listed flight, and a flight with no start at all', () => {
      assert.deepEqual(h.jobs.reserve(idOf(NEAR), [1], USER_A).reserved, [1]);
      assert.deepEqual(h.jobs.reserve(idOf(WEEK), [1], USER_A).reserved, [1]);
    });

    it('takes the flight once time brings it within the days', () => {
      h.clock.advance(3 * DAY + HOUR); // 6 days 23 hours off
      assert.deepEqual(h.jobs.reserve(idOf(FAR), [1], USER_A).reserved, [1]);
    });

    it('does not say anything changed, and does not redraw, when it refuses', async () => {
      let changes = 0;
      h.events.subscribe((e) => {
        if (e.type === 'changed') changes++;
      });
      assert.throws(() => h.jobs.reserve(idOf(FAR), [1], USER_A), JobError);
      assert.equal(changes, 0);
    });
  });

  describe('standing by as backup', () => {
    beforeEach(() => {
      h.store.insertReservation(idOf(FAR), 1, USER_A.discordId, USER_A.username, T0); // taken, though beyond the days
    });

    it('is refused for a flight beyond the days', () => {
      const view = h.store.getJobView(idOf(FAR))!;
      assert.equal(h.jobs.backupProblem(view, USER_B.discordId), tooFar(FAR, 7, 'stand by for'));
      assert.throws(() => h.jobs.addBackup(idOf(FAR), USER_B), (e: unknown) => e instanceof JobError && e.message === tooFar(FAR, 7, 'stand by for'));
      assert.equal(h.store.getJobView(idOf(FAR))!.backup, null);
      assert.deepEqual(h.jobs.backupCandidates(panel(), USER_B.discordId), []);
    });

    it('is allowed once the flight is within the days', () => {
      h.clock.advance(4 * DAY);
      assert.equal(h.jobs.backupProblem(h.store.getJobView(idOf(FAR))!, USER_B.discordId), null);
      assert.equal(h.jobs.addBackup(idOf(FAR), USER_B).backup?.discordId, USER_B.discordId);
    });

    it('through the Backup pilot conversation: it says you cannot stand by for flights that far ahead', async () => {
      h.store.insertReservation(idOf(NEAR), 1, USER_A.discordId, USER_A.username, T0); // something bob could stand by for
      await press(bob, `panel:backup:${pid}`);
      assert.match(bob.lastText, /Reply with the ID of the flight/);
      await say(bob, FAR);
      assert.equal(bob.lastText, `${tooFar(FAR, 7, 'stand by for')}\nSend a different flight ID, or say \`cancel\`.`);
      assert.equal(h.store.getJobView(idOf(FAR))!.backup, null);
    });
  });

  describe('the list view in a pilot DMs', () => {
    const listText = (u: FakeUser) => u.dmChannel.live.map((m) => (m.payload.embeds ?? []).map((e: any) => `${e.toJSON().title ?? ''}\n${e.toJSON().description ?? ''}`).join('\n')).join('\n');

    it('lists the same flights as the panel, and only counts the ones beyond the days', async () => {
      await press(alice, `panel:list:${pid}`);
      const text = listText(alice);
      assert.match(text, /\*\*TST-002\*\*/);
      assert.match(text, /\*\*TST-003\*\*/);
      assert.doesNotMatch(text, /TST-001/);
      assert.match(text, /1 more flight starts more than 7 days from now/);
    });

    it('lists it once it is within the days', async () => {
      await press(alice, `panel:list:${pid}`);
      h.clock.advance(4 * DAY);
      await d.panels.refresh(pid);
      await d.panels.refreshFollowers(pid);
      await d.panels.followersIdle();
      assert.match(listText(alice), /\*\*TST-001\*\*/);
    });

    it('does not make a flight reachable that the panel does not list, for a pilot who hides flights that are taken', async () => {
      h.store.setHideUnavailable(USER_A.discordId, true, T0);
      await press(alice, `panel:list:${pid}`);
      assert.doesNotMatch(listText(alice), /TST-001/);
      await press(alice, `panel:reserve:${pid}`);
      await say(alice, FAR);
      assert.equal(holderOf(FAR), null);
    });
  });

  describe('what was already held', () => {
    beforeEach(() => {
      h.store.insertReservation(idOf(FAR), 1, USER_A.discordId, USER_A.username, T0); // reserved before the days were enforced
    });

    it('stays with its pilot, who can still see it and give it back', () => {
      assert.deepEqual(h.jobs.mine(pid, USER_A.discordId).map((v) => v.job.code), [FAR]);
      assert.deepEqual(h.jobs.release(idOf(FAR), USER_A.discordId, [1]), [1]);
      assert.equal(holderOf(FAR), null);
    });

    it('can still be freed by an admin, by its ID', () => {
      const notices = h.jobs.adminRelease(panel(), 'TST-001');
      assert.deepEqual(notices.map((n) => [n.discordId, n.jobCode]), [[USER_A.discordId, FAR]]);
      assert.equal(holderOf(FAR), null);
    });
  });

  describe('search, which always worked this way', () => {
    it('never finds a flight beyond the days', () => {
      assert.deepEqual(h.jobs.search(panel(), ['EGLL'], []).map((v) => v.job.code), []);
      assert.deepEqual(h.jobs.search(panel(), ['EGKK'], []).map((v) => v.job.code), [NEAR]);
    });
  });
});
