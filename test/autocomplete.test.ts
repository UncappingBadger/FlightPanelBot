import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { FsHubError, type FsHubFlight } from '../src/fshub/client.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { AUTO_COMPLETE_MS, AutoCompleter } from '../src/services/autoComplete.js';
import { COMPLETION_GRACE_MS } from '../src/services/jobs.js';
import { Scheduler } from '../src/services/scheduler.js';
import { SheetWriteBack } from '../src/services/writeback.js';
import { silentLogger } from '../src/util/log.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeFsHub, FakeUser, fakeComponent, fakeDm, fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions, messageText } from './discord-helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up. The pilots, airlines and flights are not real. */

const AIRLINE_ID = 8123;
const NOW = T0 + 6 * HOUR;
const MIN = 60_000;
const { account, publicKey } = makeServiceAccount();

describe('completing flights automatically from FsHub', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  let ac: AutoCompleter;
  let alice: FakeUser;
  let bob: FakeUser;
  let pid: number;
  let fid: number;

  /** A flight FsHub lists: by Alice (FsHub 1001), EGLL to EGKK, an A320 that landed two hours ago, unless said otherwise. */
  const flown = (over: Partial<FsHubFlight> = {}): FsHubFlight => {
    const f: FsHubFlight = {
      id: ++fid,
      pilotId: 1001,
      pilotName: 'Alice Pilot',
      dep: 'EGLL',
      arr: 'EGKK',
      departedAt: NOW - 3 * HOUR,
      arrivedAt: NOW - 2 * HOUR,
      aircraftIcao: 'A320',
      aircraftName: 'Airbus A320',
      scheduleStatus: 'ON-TIME',
      ...over,
    };
    fshub.flights.set(AIRLINE_ID, [...(fshub.flights.get(AIRLINE_ID) ?? []), f]);
    return f;
  };
  const windowed = (key: string, chain: string, over: Record<string, unknown> = {}) => sj(key, chain, { availableFrom: T0, deadline: T0 + 12 * HOUR, ...over });
  const jobId = (key: string) => h.store.listJobs(pid).find((j) => j.sourceKey === key)!.id;
  const job = (key: string) => h.store.getJob(jobId(key))!;
  const panel = () => h.store.getPanel(pid)!;
  const hold = (key: string, user: FakeUser = alice) => h.jobs.reserve(jobId(key), [1], { discordId: user.id, username: user.username });
  /** A Discord account with no FsHub ID of its own yet (the test harness gives Alice, Bob and Carol one). */
  const newcomer = () => d.client.user(new FakeUser('555555555555555555', 'newcomer'));
  const panelText = () => d.client.channel('700000000000000001').live.map((m) => messageText(m)).join('\n');

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = new FakeFsHub();
    fid = 4_900_000;
    d = makeDiscordHarness(h, { fshub });
    ac = d.ctx.autoComplete!;
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK', { aircraft: 'A320' }), windowed('t', 'EGKK-EGCC', { aircraft: 'B738' }), windowed('u', 'EGCC-EGPH', { aircraft: 'A320' })]);
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is on for a panel by default, and the bot has it wired up only with a FsHub token', async () => {
    assert.equal(panel().fshubAutoComplete, true);
    assert.equal(panel().fshubAutoCompleteAt, null);
    assert.ok(ac instanceof AutoCompleter);
    const plain = await makeHarness();
    const none = makeDiscordHarness(plain);
    assert.equal(none.ctx.autoComplete, null, 'no token, no auto-complete');
    await settle(40);
    await plain.close();
  });

  describe('what it completes', () => {
    it("completes a flight FsHub shows its holder flew, with nobody pressing anything, and pins it as FsHub's", async () => {
      hold('s');
      flown();
      const [r] = await ac.run();
      assert.equal(r!.ok, true);
      assert.deepEqual(r!.completed.map((c) => [c.view.job.code, c.discordId, c.sheetTicked]), [['TST-001', alice.id, false]]);
      const j = job('s');
      assert.deepEqual([j.status, j.completedAt, j.completedBy, j.completedVia], ['expired', NOW, alice.id, 'fshub']);
      assert.equal(h.jobs.open(pid).some((v) => v.job.sourceKey === 's'), false, 'no longer an open flight');
    });

    it('puts it on the completed flights panel, with what FsHub recorded, and out of the open flights', async () => {
      hold('s');
      flown();
      await ac.run();
      await settle(1700);
      const [open, done] = d.client.channel('700000000000000001').live.map((m) => messageText(m)) as [string, string];
      assert.doesNotMatch(open, /^TST-001 ·/m);
      assert.match(open, /^TST-002 ·/m);
      assert.match(done, /^TST-001 · A320 · on time\n## EGLL ✈ EGKK\n\*Airbus A320\*\nFLOWN BY: <@\d+> · FsHub #1001\nLANDED: <t:\d+:t>\nFSHUB: \[flight #\d+\]\(https:\/\/fshub\.io\/flight\/\d+\/report\)$/m);
    });

    it('completes a flight with several legs only when FsHub has shown every one, and tells them all in one message', async () => {
      h.jobs.sync(pid, [windowed('m', 'LFPG-EHAM-EDDF')]);
      h.jobs.reserve(jobId('m'), [1, 2], { discordId: alice.id, username: alice.username });
      flown({ dep: 'LFPG', arr: 'EHAM' });
      const partial = await ac.runPanel(panel());
      assert.deepEqual([partial.ok, partial.completed.length, partial.checked], [true, 0, 1], 'one leg of two is not enough');
      assert.equal(job('m').completedAt, null);
      assert.equal(alice.dms.length, 0, 'and nobody is told');

      flown({ dep: 'EHAM', arr: 'EDDF', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR, aircraftIcao: 'B738', aircraftName: 'Boeing 737-800' });
      h.clock.now = NOW + 2 * MIN;
      const full = await ac.runPanel(panel());
      assert.equal(full.completed.length, 1);
      assert.equal(job('m').completedVia, 'fshub');
      assert.match(alice.lastText, /leg 1: A320 \(Airbus A320\), landed <t:\d+:t> · on time; leg 2: B738 \(Boeing 737-800\), landed/);
    });

    it('does not let one FsHub flight complete two scheduled flights', async () => {
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK'), windowed('s2', 'EGLL-EGKK')]);
      hold('s');
      hold('s2');
      flown();
      const r = await ac.runPanel(panel());
      assert.equal(r.completed.length, 1);
      assert.equal(r.checked, 2);
    });

    it('completes a flight whose deadline has just passed, when the landing was inside its window', async () => {
      hold('s');
      flown({ arrivedAt: T0 + 12 * HOUR + 10 * MIN, departedAt: T0 + 11 * HOUR });
      h.clock.now = T0 + 12 * HOUR + 30 * MIN;
      h.jobs.expireDue();
      assert.equal(job('s').status, 'expired');
      const r = await ac.runPanel(panel());
      assert.equal(r.completed.length, 1);
      assert.equal(job('s').completedVia, 'fshub');
    });

    it('is not undone by a later read of a sheet that still shows the flight as not done', async () => {
      hold('s');
      flown();
      await ac.run();
      h.clock.now = NOW + COMPLETION_GRACE_MS + HOUR;
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK', { aircraft: 'A320' })]); // the sheet's box is still unticked
      assert.notEqual(job('s').completedAt, null);
      assert.equal(job('s').completedVia, 'fshub');
    });

    it('has nothing more to do once a flight is completed', async () => {
      hold('s');
      flown();
      assert.equal((await ac.runPanel(panel())).completed.length, 1);
      h.clock.now = NOW + 2 * MIN;
      const again = await ac.runPanel(panel());
      assert.deepEqual([again.ok, again.checked, again.completed.length], [true, 0, 0]);
      assert.equal(alice.dms.length, 1, 'and the pilot was not told twice');
    });
  });

  describe('what it leaves alone', () => {
    it('a flight nobody holds, and a flight only the airline\'s sheet gives a name to', async () => {
      const named = windowed('named', 'EGKK-EGCC');
      named.legs[0]!.heldBy = 'Taylor';
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK'), named]);
      flown();
      flown({ dep: 'EGKK', arr: 'EGCC', pilotId: 777 });
      const r = await ac.runPanel(panel());
      assert.deepEqual([r.ok, r.checked, r.completed.length], [true, 0, 0], 'no Discord holder, so nothing says whose they are');
      assert.equal(job('s').completedAt, null);
      assert.equal(job('named').completedAt, null);
    });

    it('a flight someone else flew, even when theirs is the only flight on the route', async () => {
      hold('s');
      flown({ pilotId: 4242 });
      const r = await ac.runPanel(panel());
      assert.deepEqual([r.checked, r.completed.length], [1, 0]);
      assert.equal(job('s').completedAt, null);
    });

    it("a flight held by one pilot that another pilot flew (each is only ever matched to their own)", async () => {
      hold('s', bob);
      flown({ pilotId: 1001 }); // Alice flew it; Bob holds it
      assert.equal((await ac.runPanel(panel())).completed.length, 0);
      assert.equal(job('s').completedAt, null);
    });

    it('a multi-leg flight two pilots share, even when FsHub shows both legs flown', async () => {
      h.jobs.sync(pid, [windowed('m', 'LFPG-EHAM-EDDF')]);
      h.jobs.reserve(jobId('m'), [1], { discordId: alice.id, username: alice.username });
      h.jobs.reserve(jobId('m'), [2], { discordId: bob.id, username: bob.username });
      flown({ dep: 'LFPG', arr: 'EHAM' });
      flown({ dep: 'EHAM', arr: 'EDDF', pilotId: 1002, arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      assert.equal((await ac.runPanel(panel())).completed.length, 0);
      assert.equal(job('m').completedAt, null);
    });

    it('a flight that has not started yet', async () => {
      h.jobs.sync(pid, [windowed('later', 'EGPH-EGLL', { availableFrom: NOW + 5 * HOUR, deadline: NOW + 20 * HOUR })]);
      hold('later');
      flown({ dep: 'EGPH', arr: 'EGLL' });
      const r = await ac.runPanel(panel());
      assert.deepEqual([r.checked, r.completed.length], [0, 0]);
    });

    it('a landing outside the flight\'s window (an hour either side)', async () => {
      hold('s');
      flown({ arrivedAt: T0 - 2 * HOUR, departedAt: T0 - 3 * HOUR });
      assert.equal((await ac.runPanel(panel())).completed.length, 0);
      assert.equal(job('s').completedAt, null);
    });

    it('a pilot whose FsHub ID the bot does not know', async () => {
      const dave = newcomer();
      hold('s', dave);
      flown({ pilotId: 500 });
      const r = await ac.runPanel(panel());
      assert.deepEqual([r.checked, r.completed.length], [0, 0]);
    });

    it('an ID somebody typed when the airline roster says it belongs to another Discord account', async () => {
      const dave = newcomer();
      h.store.setPilotId(dave.id, 500, NOW, 'Roster Pilot'); // typed by him
      h.store.applyRosterLinks([{ discordId: '666666666666666666', fshubId: 500, name: 'Roster Pilot' }], NOW);
      hold('s', dave);
      flown({ pilotId: 500 });
      const r = await ac.runPanel(panel());
      assert.deepEqual([r.checked, r.completed.length], [0, 0]);
      assert.equal(job('s').completedAt, null);
      assert.equal(dave.dms.length, 0);
    });

    it('yet takes an ID the roster itself gave the pilot, and a typed one nobody else claims', async () => {
      const carol = newcomer();
      h.store.applyRosterLinks([{ discordId: carol.id, fshubId: 500, name: 'Roster Pilot' }], NOW);
      hold('s', carol);
      flown({ pilotId: 500 });
      assert.equal((await ac.runPanel(panel())).completed.length, 1);

      const erin = d.client.user(new FakeUser('444444444444444444', 'erin'));
      h.store.setPilotId(erin.id, 501, NOW, 'Some Pilot');
      hold('t', erin);
      flown({ dep: 'EGKK', arr: 'EGCC', pilotId: 501 });
      h.clock.now = NOW + 2 * MIN;
      assert.equal((await ac.runPanel(panel())).completed.length, 1);
    });
  });

  describe('every hour', () => {
    it('checks a panel that has never been checked, then not again until an hour has passed', async () => {
      hold('s');
      const first = await ac.run();
      assert.equal(first.length, 1);
      assert.equal(panel().fshubAutoCompleteAt, NOW);

      flown();
      h.clock.now = NOW + 59 * MIN;
      assert.deepEqual(await ac.run(), [], 'not due yet');
      assert.equal(job('s').completedAt, null);

      h.clock.now = NOW + AUTO_COMPLETE_MS;
      const again = await ac.run();
      assert.equal(again[0]!.completed.length, 1);
      assert.equal(panel().fshubAutoCompleteAt, NOW + AUTO_COMPLETE_MS);
    });

    it('is exactly an hour', () => {
      assert.equal(AUTO_COMPLETE_MS, 3_600_000);
    });

    it('reads FsHub first, so a landing from a few minutes ago is there without waiting for the scheduled read', async () => {
      hold('s');
      assert.equal(fshub.flightCalls.length, 0);
      flown({ arrivedAt: NOW - 3 * MIN, departedAt: NOW - HOUR });
      assert.equal((await ac.run())[0]!.completed.length, 1);
      assert.ok(fshub.flightCalls.length >= 1);
    });

    it('does nothing for a panel an admin switched it off for, and does not trouble FsHub', async () => {
      hold('s');
      flown();
      h.store.updatePanel(pid, { fshubAutoComplete: false });
      assert.deepEqual(await ac.run(), []);
      assert.equal(job('s').completedAt, null);
      assert.equal(fshub.flightCalls.length, 0);
    });

    it('does nothing for a panel that is not reading FsHub flights, or is not linked to an airline', async () => {
      hold('s');
      flown();
      h.store.updatePanel(pid, { fshubConfirm: false });
      assert.deepEqual(await ac.run(), []);
      assert.equal((await ac.runPanel(panel())).ok, false, 'asked directly, it says why');
      h.store.updatePanel(pid, { fshubConfirm: true, fshubAirlineId: null });
      assert.deepEqual(await ac.run(), []);
      assert.equal(job('s').completedAt, null);
      assert.equal(fshub.flightCalls.length, 0);
    });

    it('looks at each linked panel, each on its own schedule', async () => {
      const other = h.store.createPanel({ guildId: '9', name: 'Other Air', prefix: 'OTH', channelId: '8', now: NOW });
      h.store.updatePanel(other.id, { fshubAirlineId: 6000, fshubAirlineName: 'Other Air' });
      h.store.updatePanel(pid, { fshubAutoCompleteAt: NOW - 10 * MIN }); // checked ten minutes ago
      const ran = await ac.run();
      assert.equal(ran.length, 1, 'only the one that is due');
      assert.equal(h.store.getPanel(other.id)!.fshubAutoCompleteAt, NOW);
      assert.equal(panel().fshubAutoCompleteAt, NOW - 10 * MIN);
    });
  });

  describe('when FsHub cannot be read', () => {
    it('completes nothing, takes nobody\'s word for it, and tries again in ten minutes rather than an hour', async () => {
      hold('s');
      flown();
      fshub.flightError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
      const [r] = await ac.run();
      assert.deepEqual([r!.ok, r!.completed.length], [false, 0]);
      assert.match(r!.note!, /couldn't reach FsHub/);
      assert.equal(job('s').completedAt, null);
      assert.equal(alice.dms.length, 0);

      h.clock.now = NOW + 9 * MIN;
      assert.deepEqual(await ac.run(), [], 'not yet');
      fshub.flightError = null;
      h.clock.now = NOW + 10 * MIN;
      const retry = await ac.run();
      assert.equal(retry[0]!.completed.length, 1, 'back up, so it completes what had been flown');
    });
  });

  describe('telling the pilots', () => {
    it('sends each pilot one DM, however many of their flights were completed, naming only theirs, and pinging nobody', async () => {
      hold('s');
      hold('t');
      hold('u', bob);
      flown();
      flown({ dep: 'EGKK', arr: 'EGCC', aircraftIcao: 'B738', aircraftName: 'Boeing 737-800', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      flown({ dep: 'EGCC', arr: 'EGPH', pilotId: 1002, arrivedAt: NOW - 30 * MIN, departedAt: NOW - 90 * MIN });
      await ac.run();

      assert.equal(alice.dms.length, 1);
      assert.match(alice.lastText, /^FsHub shows you flew 2 flights for \*\*Test Air\*\*, so I marked them completed:/);
      assert.match(alice.lastText, /✅ \*\*TST-001\*\* \(EGLL → EGKK\): A320 \(Airbus A320\), landed <t:\d+:t> · on time/);
      assert.match(alice.lastText, /✅ \*\*TST-002\*\* \(EGKK → EGCC\): B738 \(Boeing 737-800\)/);
      assert.doesNotMatch(alice.lastText, /TST-003/);
      assert.match(alice.lastText, /There is nothing for you to do\. I check FsHub for your landings every hour\.$/);
      assert.deepEqual(alice.last.allowedMentions, { parse: [] });

      assert.equal(bob.dms.length, 1);
      assert.match(bob.lastText, /^FsHub shows you flew a flight for \*\*Test Air\*\*, so I marked it completed:/);
      assert.match(bob.lastText, /✅ \*\*TST-003\*\* \(EGCC → EGPH\)/);
      assert.doesNotMatch(bob.lastText, /TST-001|TST-002/);
    });

    it('still completes the flight when the pilot has DMs closed', async () => {
      hold('s');
      flown();
      alice.failDms = true;
      const [r] = await ac.run();
      assert.equal(r!.completed.length, 1);
      assert.equal(job('s').completedVia, 'fshub');
    });

    it('still completes the flights when telling a pilot fails in some other way', async () => {
      const grumpy = new AutoCompleter({
        store: h.store,
        jobs: h.jobs,
        sync: d.ctx.fshubSync!,
        writeback: null,
        logger: silentLogger,
        now: () => h.clock.now,
        onCompleted: async () => {
          throw new Error('the notifier broke');
        },
      });
      hold('s');
      flown();
      const r = await grumpy.runPanel(panel());
      assert.equal(r.ok, true);
      assert.equal(r.completed.length, 1);
      assert.equal(job('s').completedVia, 'fshub');
    });

    it('says nothing of the sheet when there is no sheet, and the DM never makes up a flight', async () => {
      hold('s');
      flown();
      await ac.run();
      assert.doesNotMatch(alice.lastText, /sheet/);
    });
  });

  describe('the panel says so', () => {
    const intro = () => String(d.client.channel('700000000000000001').live[0]!.payload.embeds[0].toJSON().description);

    it('tells pilots that flown flights are completed every hour while it is on', async () => {
      await d.panels.refresh(pid);
      assert.match(intro(), /I complete flights that FsHub shows you flew every hour; press \*\*Complete\*\* to do it now\./);
    });

    it('goes back to the plain wording when it is switched off, when the panel is not linked, and when the bot has no token', async () => {
      h.store.updatePanel(pid, { fshubAutoComplete: false });
      await d.panels.refresh(pid);
      assert.match(intro(), /Flown it\? Press \*\*Complete\*\*\./);
      assert.doesNotMatch(intro(), /every hour/);

      h.store.updatePanel(pid, { fshubAutoComplete: true, fshubAirlineId: null });
      await d.panels.refresh(pid);
      assert.doesNotMatch(intro(), /every hour/);

      h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID });
      d.panels.fshubEnabled = false;
      await d.panels.refresh(pid);
      assert.doesNotMatch(intro(), /every hour/);
    });

    it('does not repeat the instructions on the completed flights panel', async () => {
      await d.panels.refresh(pid);
      const last = d.client.channel('700000000000000001').live.at(-1)!.payload.embeds[0].toJSON();
      assert.doesNotMatch(String(last.description), /Reserve/);
      assert.match(panelText(), /Nothing has been completed in the last 24 hours\./);
    });
  });
});

/* ------------------------------------------------------------------ with the airline's Google Sheet */

describe('completing automatically on a panel whose schedule is a Google Sheet', () => {
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  const pid = () => h.panel.id;
  const SHEET_NOW = Date.UTC(2026, 10, 12, 20, 0); // the evening of the day TST-001 (EGLL-EGCC, 0600-2359z) is flown

  const syncFromSheet = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const job = () => h.store.listJobs(pid()).find((j) => h.store.listLegs(j.id).some((l) => l.dep === 'EGLL' && l.arr === 'EGCC'))!;
  const press = async (customId: string) => {
    const f = fakeComponent(alice, customId, {});
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const reserve = async () => {
    await press(`panel:reserve:${pid()}`);
    await handleDmMessage(d.ctx, fakeDm(alice, 'TST-001'));
  };
  const landed = () =>
    fshub.flights.set(AIRLINE_ID, [
      { id: 4_900_001, pilotId: 1001, pilotName: 'Alice', dep: 'EGLL', arr: 'EGCC', departedAt: SHEET_NOW - 3 * HOUR, arrivedAt: SHEET_NOW - 2 * HOUR, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME' },
    ]);

  const boot = async (withWriteback: boolean) => {
    h = await makeHarness();
    h.clock.now = SHEET_NOW;
    g = new FakeGoogle(publicKey);
    fshub = new FakeFsHub();
    const wb = withWriteback ? new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now }) : null;
    d = makeDiscordHarness(h, { writeback: wb, fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    syncFromSheet();
    await d.panels.refresh(pid());
  };
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('with write-back on, ticks the box in the sheet before completing, and says so in the DM', async () => {
    await boot(true);
    await reserve();
    assert.equal(g.cell('E3'), 'alice');
    landed();
    const [r] = await d.ctx.autoComplete!.run();
    assert.deepEqual(r!.completed.map((c) => c.sheetTicked), [true]);
    assert.deepEqual([g.cell('E3'), g.cell('H3')], ['alice', 'TRUE']);
    assert.equal(job().completedVia, 'fshub');
    assert.match(alice.lastText, /· ticked in the airline's sheet/);
  });

  it('with write-back on, leaves a flight the sheet has given to someone else, and says nothing to the pilot', async () => {
    await boot(true);
    await reserve();
    landed();
    g.values[2]![4] = 'Sam';
    const told = alice.dms.length; // the reservation's own messages
    const [r] = await d.ctx.autoComplete!.run();
    assert.equal(r!.completed.length, 0);
    assert.equal(g.cell('H3'), 'FALSE');
    assert.equal(job().completedAt, null);
    assert.equal(alice.dms.length, told, 'and the pilot is told nothing');
  });

  it('with no write-back, still completes on the panel, and the next sheet read does not undo it', async () => {
    await boot(false);
    await reserve();
    landed();
    const [r] = await d.ctx.autoComplete!.run();
    assert.deepEqual(r!.completed.map((c) => c.sheetTicked), [false]);
    assert.doesNotMatch(alice.lastText, /sheet/);
    h.clock.now = SHEET_NOW + COMPLETION_GRACE_MS + HOUR;
    syncFromSheet(); // the sheet's box is still unticked
    assert.notEqual(job().completedAt, null);
  });
});

/* ------------------------------------------------------------------ the scheduler's FsHub lane */

describe("the scheduler's FsHub lane", () => {
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

  it('runs the FsHub reads and then the completion beside the main pass, which does not wait for them', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new Scheduler(h.jobs, d.refresher, {
      reminders: { run: async () => calls.push('reminders') },
      markets: { run: async () => void calls.push('markets') },
      fshub: {
        run: async () => {
          calls.push('fshub start');
          await gate;
          calls.push('fshub end');
        },
      },
      autoComplete: { run: async () => void calls.push('auto-complete') },
    });
    await s.tick();
    assert.deepEqual(calls, ['reminders', 'markets', 'fshub start'], 'the pass finished while FsHub was still being read');
    release();
    await s.idle();
    assert.deepEqual(calls, ['reminders', 'markets', 'fshub start', 'fshub end', 'auto-complete'], 'the completion follows the reads');
  });

  it('skips a lane that is still running rather than starting a second one', async () => {
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new Scheduler(h.jobs, d.refresher, {
      fshub: {
        run: async () => {
          starts++;
          await gate;
        },
      },
    });
    await s.tick();
    await s.tick();
    await s.tick();
    assert.equal(starts, 1);
    release();
    await s.idle();
    await s.tick();
    await s.idle();
    assert.equal(starts, 2, 'and starts afresh once the first has finished');
  });

  it('keeps going when the FsHub reads fail, still does the completion, and never fails the pass', async () => {
    const calls: string[] = [];
    const s = new Scheduler(h.jobs, d.refresher, {
      markets: { run: async () => void calls.push('markets') },
      fshub: { run: async () => Promise.reject(new Error('boom')) },
      autoComplete: { run: async () => void calls.push('auto-complete') },
    });
    await assert.doesNotReject(s.tick());
    await s.idle();
    assert.deepEqual(calls, ['markets', 'auto-complete']);
  });

  it('and a failing completion does not fail anything either', async () => {
    const s = new Scheduler(h.jobs, d.refresher, { autoComplete: { run: async () => Promise.reject(new Error('boom')) } });
    await assert.doesNotReject(s.tick());
    await assert.doesNotReject(s.idle());
    await s.tick();
    await s.idle();
  });

  it('has nothing to wait for when the bot has no FsHub token', async () => {
    const s = new Scheduler(h.jobs, d.refresher, {});
    await s.tick();
    await assert.doesNotReject(s.idle());
  });

  it('does the real work: a pass completes what FsHub shows flown, and a later one does not do it again within the hour', async () => {
    const fshub = new FakeFsHub();
    const dd = makeDiscordHarness(h, { fshub });
    const alice = dd.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    h.clock.now = NOW;
    h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    h.jobs.sync(h.panel.id, [sj('s', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 12 * HOUR })]);
    h.jobs.reserve(h.store.listJobs(h.panel.id)[0]!.id, [1], { discordId: alice.id, username: alice.username });
    fshub.flights.set(AIRLINE_ID, [
      { id: 1, pilotId: 1001, pilotName: 'Alice', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - 3 * HOUR, arrivedAt: NOW - 2 * HOUR, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME' },
    ]);
    const s = new Scheduler(h.jobs, dd.refresher, { fshub: dd.ctx.fshubSync!, autoComplete: dd.ctx.autoComplete! });
    await s.tick();
    await s.idle();
    assert.equal(h.store.listJobs(h.panel.id)[0]!.completedVia, 'fshub');
    assert.equal(alice.dms.length, 1);
    const reads = fshub.flightCalls.length;
    h.clock.now = NOW + 20 * MIN;
    await s.tick();
    await s.idle();
    assert.equal(alice.dms.length, 1);
    assert.equal(h.store.getPanel(h.panel.id)!.fshubAutoCompleteAt, NOW, 'not checked again after twenty minutes');
    assert.ok(fshub.flightCalls.length >= reads);
  });
});

/* ------------------------------------------------------------------ /setup fshub autocomplete */

describe('/setup fshub autocomplete', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  const AIRLINE = { id: AIRLINE_ID, name: 'Test Air', abbr: 'TST' };

  const run = async (o: FakeInteractionOptions = {}, sub = 'fshub') => {
    const f = fakeInteraction({ sub, admin: true, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  const panel = () => h.store.getPanel(h.panel.id)!;
  const startFlight = () => {
    h.jobs.sync(h.panel.id, [sj('s', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 12 * HOUR })]);
    h.jobs.reserve(h.store.listJobs(h.panel.id)[0]!.id, [1], { discordId: alice.id, username: alice.username });
  };
  const landed = () =>
    fshub.flights.set(AIRLINE_ID, [
      { id: 1, pilotId: 1001, pilotName: 'Alice', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - 3 * HOUR, arrivedAt: NOW - 2 * HOUR, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME' },
    ]);

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = new FakeFsHub();
    fshub.mine = [AIRLINE];
    fshub.airlines.set(AIRLINE.id, AIRLINE);
    fshub.rosters.set(AIRLINE.id, [{ id: 1001, name: 'Alice Pilot', discordId: USER_A.discordId }]);
    d = makeDiscordHarness(h, { fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is an on/off choice on the fshub subcommand', () => {
    const sub = (setup.data.toJSON().options ?? []).find((o) => o.name === 'fshub') as unknown as { options: Array<{ name: string; description: string; choices?: Array<{ value: string }> }> };
    const opt = sub.options.find((o) => o.name === 'autocomplete')!;
    assert.ok(opt.description.length <= 100);
    assert.deepEqual(opt.choices!.map((c) => c.value), ['on', 'off']);
  });

  it('off stops it for that panel, says what that means, and leaves the Complete button alone', async () => {
    const reply = await run({ options: { autocomplete: 'off' } });
    assert.match(reply, /I've stopped completing flights automatically on the \*\*Test Air\*\* panel\. Pilots can still press \*\*Complete\*\*/);
    assert.equal(panel().fshubAutoComplete, false);
    startFlight();
    landed();
    assert.deepEqual(await d.ctx.autoComplete!.run(), []);
    assert.equal(h.store.listJobs(h.panel.id)[0]!.completedAt, null);
    assert.equal(fshub.flightCalls.length, 0);
  });

  it('on turns it back on, checks at once instead of leaving the admin to wait an hour, and says what it did', async () => {
    h.store.updatePanel(h.panel.id, { fshubAutoComplete: false, fshubAutoCompleteAt: NOW - HOUR });
    startFlight();
    landed();
    const reply = await run({ options: { autocomplete: 'on' } });
    assert.match(reply, /Every hour I'll complete the flights FsHub shows pilots flew on the \*\*Test Air\*\* panel, and tell each pilot in a DM\./);
    assert.match(reply, /Auto-complete: I looked at 1 flight pilots hold and completed \*\*TST-001\*\* \(FsHub shows it flown\)\. I do this check every hour\./);
    assert.equal(panel().fshubAutoComplete, true);
    assert.equal(h.store.listJobs(h.panel.id)[0]!.completedVia, 'fshub');
    assert.equal(panel().fshubAutoCompleteAt, NOW);
    assert.equal(alice.dms.length, 1);
  });

  it('with no options on a linked panel reads FsHub now and runs the check, saying how it went', async () => {
    startFlight();
    const quiet = await run({});
    assert.match(quiet, /Auto-complete: I looked at 1 flight pilots hold; none has been flown yet according to FsHub\. I check every hour\./);
    assert.equal(h.store.listJobs(h.panel.id)[0]!.completedAt, null);

    landed();
    h.clock.now = NOW + 2 * MIN;
    const done = await run({});
    assert.match(done, /completed \*\*TST-001\*\*/);
  });

  it('says there was nothing to check when no pilot holds a flight that has started', async () => {
    assert.match(await run({}), /Auto-complete: no pilot holds a flight that has started, so there was nothing to check\./);
  });

  it('says so when FsHub could not be asked, and completes nothing', async () => {
    startFlight();
    landed();
    fshub.flightError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
    const reply = await run({});
    assert.match(reply, /⚠️ I couldn't read the airline's recent flights yet/);
    assert.doesNotMatch(reply, /Auto-complete: I looked/);
    assert.equal(h.store.listJobs(h.panel.id)[0]!.completedAt, null);
  });

  it('does not run the check when it is switched off, but still reads the roster and flights', async () => {
    h.store.updatePanel(h.panel.id, { fshubAutoComplete: false });
    startFlight();
    landed();
    const reply = await run({});
    assert.match(reply, /is linked to the \*\*Test Air\*\* panel/);
    assert.doesNotMatch(reply, /Auto-complete:/);
    assert.equal(h.store.listJobs(h.panel.id)[0]!.completedAt, null);
  });

  it('is listed in /setup panels, with when it last checked', async () => {
    const on = await run({}, 'panels');
    assert.match(on, /auto-complete: hourly/);
    await run({});
    assert.match(await run({}, 'panels'), /auto-complete: hourly \(checked <t:\d+:R>\)/);
    await run({ options: { autocomplete: 'off' } });
    assert.match(await run({}, 'panels'), /auto-complete: off/);
    h.store.updatePanel(h.panel.id, { fshubConfirm: false });
    assert.doesNotMatch(await run({}, 'panels'), /auto-complete/, 'with flights not being read there is nothing to complete from');
  });

  it('refuses a non-admin, as the rest of /setup does', async () => {
    await assert.rejects(run({ admin: false, options: { autocomplete: 'off' } }), /Manage Server/);
    assert.equal(panel().fshubAutoComplete, true);
  });
});
