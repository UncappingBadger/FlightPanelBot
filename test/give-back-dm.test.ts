import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { setupCommand } from '../src/discord/commands/setup.js';
import { openAgainText } from '../src/discord/dm.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { fakeComponent, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;
const setup = setupCommand;

/** What a pilot is told after giving a flight back that nobody is standing by for. */
const told = (code: string, route: string) =>
  `You've given back **${code}** (${route}), and nobody is down as its backup, so it is open again. If anyone you know is free to fly it, let them know: they can press **Reserve** on the panel and reply with the flight ID.`;

describe('giving a flight back that nobody is standing by for', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const idOf = (code: string) => h.store.listJobs(pid()).find((j) => j.code === code)!.id;
  const hold = (code: string, user = USER_A, legs = [1]) => h.jobs.reserve(idOf(code), legs, user);
  /** Press the release menu in the panel's My flights message, picking `values` (job:leg). */
  const give = async (user: FakeUser, ...values: string[]) => {
    const f = fakeComponent(user, `panel:release:${pid()}`, { values });
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, f.i);
    await settle();
    return f.calls;
  };
  const dmsAbout = (user: FakeUser) => user.dms.map((m) => String(m.content)).filter((c) => /let them know/.test(c));

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.jobs.sync(pid(), [
      sj('a', 'EGLL-EGKK', { availableFrom: T0 + 5 * HOUR, deadline: T0 + 40 * HOUR }),
      sj('b', 'EGKK-EGCC', { availableFrom: T0 + 2 * HOUR, deadline: T0 + 40 * HOUR }),
      sj('m', 'EGLL-EGKK-EGCC-EGPH', { availableFrom: T0 + 8 * HOUR, deadline: T0 + 40 * HOUR }),
      sj('far', 'EGLL-EGPH', { availableFrom: T0 + 3 * DAY, deadline: T0 + 4 * DAY }),
    ]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  describe('what the pilot is told', () => {
    it('is that it is open again, and to tell anyone they know who is free, in a DM', async () => {
      hold('TST-001');
      await give(alice, `${idOf('TST-001')}:1`);
      assert.equal(alice.dms.length, 1);
      assert.equal(alice.lastText, told('TST-001', 'EGLL → EGKK'));
      assert.deepEqual(alice.last.allowedMentions, { parse: [] }, 'pings nobody');
    });

    it('still answers the menu as before', async () => {
      hold('TST-001');
      const calls = await give(alice, `${idOf('TST-001')}:1`);
      assert.match(calls.edits.at(-1).content, /^Released: TST-001 leg 1\. The panel is updated and those legs are free again\.$/);
      assert.equal(h.jobs.view(idOf('TST-001'))!.legs[0]!.holder, null);
    });

    it('is one message listing every flight given back at once, soonest first', async () => {
      hold('TST-001');
      hold('TST-002');
      await give(alice, `${idOf('TST-001')}:1`, `${idOf('TST-002')}:1`);
      assert.equal(alice.dms.length, 1);
      assert.equal(
        alice.lastText,
        "You've given back:\n• **TST-002** (EGKK → EGCC)\n• **TST-001** (EGLL → EGKK)\nNobody is down as backup, so they are open again.\nIf anyone you know is free to fly them, let them know: they can press **Reserve** on the panel and reply with the flight ID.",
      );
    });

    it('names the legs, and only their route, for a flight with several legs', async () => {
      hold('TST-003', USER_A, [1, 2, 3]);
      await give(alice, `${idOf('TST-003')}:2`);
      assert.equal(alice.lastText, told('TST-003', 'EGKK → EGCC').replace('**TST-003** (', '**TST-003** leg 2 ('));
      await give(alice, `${idOf('TST-003')}:1`, `${idOf('TST-003')}:3`);
      assert.match(alice.lastText, /^You've given back \*\*TST-003\*\* legs 1 and 3 \(EGLL → EGKK, EGCC → EGPH\), and nobody is down as its backup, so it is open again\./);
    });

    it('is not an optional message: it still comes with every optional one switched off', async () => {
      for (const kind of ['completed', 'takeoff', 'landing'] as const) h.store.setNotice(alice.id, kind, false, T0);
      hold('TST-001');
      await give(alice, `${idOf('TST-001')}:1`);
      assert.equal(alice.lastText, told('TST-001', 'EGLL → EGKK'));
    });

    it('is said in the answer instead when the pilot has DMs closed', async () => {
      alice.failDms = true;
      hold('TST-001');
      const calls = await give(alice, `${idOf('TST-001')}:1`);
      assert.match(calls.edits.at(-1).content, /^Released: TST-001 leg 1\. The panel is updated and those legs are free again\.\nYou've given back \*\*TST-001\*\* \(EGLL → EGKK\), and nobody is down as its backup/);
      assert.equal(h.jobs.view(idOf('TST-001'))!.legs[0]!.holder, null, 'and it was still given back');
    });
  });

  describe('when it is not said', () => {
    it('is not said when the flight had a backup: the backup is told instead, as before', async () => {
      hold('TST-001');
      h.jobs.addBackup(idOf('TST-001'), USER_B);
      await give(alice, `${idOf('TST-001')}:1`);
      assert.deepEqual(dmsAbout(alice), []);
      assert.match(bob.lastText, /^Heads up: nobody is flying \*\*TST-001\*\* any more, and you were down as its backup\./);
    });

    it('is said only for the flights that had no backup, when some did', async () => {
      hold('TST-001');
      hold('TST-002');
      h.jobs.addBackup(idOf('TST-001'), USER_B);
      await give(alice, `${idOf('TST-001')}:1`, `${idOf('TST-002')}:1`);
      assert.equal(alice.lastText, told('TST-002', 'EGKK → EGCC'));
      assert.equal(dmsAbout(alice).length, 1);
    });

    it('is not said for a flight the panel does not list yet: nobody can book it', async () => {
      hold('TST-001');
      h.store.updatePanel(pid(), { showDays: 7 });
      hold('TST-004');
      h.store.updatePanel(pid(), { showDays: 1 });
      await give(alice, `${idOf('TST-004')}:1`);
      assert.deepEqual(dmsAbout(alice), []);
    });

    it('is not said for a flight that is over', async () => {
      hold('TST-001');
      h.clock.advance(41 * HOUR); // past its deadline, before any sweep has closed it
      await give(alice, `${idOf('TST-001')}:1`);
      assert.deepEqual(dmsAbout(alice), []);
    });

    it('is not said for a flight that has been completed', async () => {
      hold('TST-001');
      h.jobs.complete(idOf('TST-001'), USER_A.discordId);
      const calls = await give(alice, `${idOf('TST-001')}:1`);
      assert.deepEqual(dmsAbout(alice), []);
      assert.equal(calls.edits.at(-1).content, 'TST-001 has already finished, so there is nothing to give back.');
      assert.equal(h.store.getHolder(idOf('TST-001'), 1)?.discordId, USER_A.discordId, 'it stays with the pilot who flew it');
    });

    it('is not said when nothing was given back (someone else holds the leg, or it was already given back)', async () => {
      hold('TST-001', USER_B);
      await give(alice, `${idOf('TST-001')}:1`);
      assert.deepEqual(dmsAbout(alice), []);
      hold('TST-002');
      h.jobs.release(idOf('TST-002'), USER_A.discordId);
      await give(alice, `${idOf('TST-002')}:1`);
      assert.deepEqual(dmsAbout(alice), []);
    });

    it('is not said when the pilot only stands down as a backup', async () => {
      hold('TST-001', USER_B);
      h.jobs.addBackup(idOf('TST-001'), USER_A);
      await give(alice, `b:${idOf('TST-001')}`);
      assert.deepEqual(dmsAbout(alice), []);
    });

    it('is not said to anyone else', async () => {
      hold('TST-001');
      await give(alice, `${idOf('TST-001')}:1`);
      assert.deepEqual(dmsAbout(bob), []);
    });

    it('is not said when an admin frees someone\'s flight: that is not the pilot taking themselves off it', async () => {
      hold('TST-001');
      const f = fakeInteraction({ sub: 'release', admin: true, options: { code: 'TST-001' } });
      await setup.execute(d.ctx, f.i);
      await settle();
      assert.deepEqual(dmsAbout(alice), []);
      assert.match(alice.lastText, /^Heads up: flight \*\*TST-001\*\*/, 'they are told as before');
    });

    it('is said for just the leg given back when other pilots still fly the rest of the flight and nobody stands by', async () => {
      hold('TST-003', USER_A, [1]);
      hold('TST-003', USER_B, [2, 3]);
      assert.equal(h.jobs.view(idOf('TST-003'))!.backup, null);
      await give(alice, `${idOf('TST-003')}:1`);
      assert.equal(dmsAbout(alice).length, 1);
      assert.match(alice.lastText, /\*\*TST-003\*\* leg 1 \(EGLL → EGKK\)/);
      assert.doesNotMatch(alice.lastText, /leg 2|leg 3/);
    });
  });
});

describe('the wording for a flight given back', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('m', 'EGLL-EGKK-EGCC')]);
  });
  afterEach(() => h.close());
  const view = (code: string) => h.jobs.open(h.panel.id).find((v) => v.job.code === code)!;

  it('is nothing for no flights', () => {
    assert.equal(openAgainText([]), null);
  });

  it('is singular for one flight and plural for several', () => {
    const one = openAgainText([{ view: view('TST-001'), legs: [1] }])!;
    assert.match(one, /and nobody is down as its backup, so it is open again\. If anyone you know is free to fly it, let them know/);
    const two = openAgainText([{ view: view('TST-001'), legs: [1] }, { view: view('TST-002'), legs: [1, 2] }])!;
    assert.match(two, /Nobody is down as backup, so they are open again\.\nIf anyone you know is free to fly them, let them know/);
    assert.match(two, /• \*\*TST-002\*\* legs 1 and 2 \(EGLL → EGKK → EGCC\)/);
  });

  it('says leg, not legs, for one leg of a flight with several', () => {
    assert.match(openAgainText([{ view: view('TST-002'), legs: [2] }])!, /\*\*TST-002\*\* leg 2 \(EGKK → EGCC\)/);
  });

  it('does not number the legs of a one-leg flight', () => {
    assert.doesNotMatch(openAgainText([{ view: view('TST-001'), legs: [1] }])!, /leg 1/);
  });
});
