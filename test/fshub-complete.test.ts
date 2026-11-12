import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage, completesFromFsHub } from '../src/discord/dm.js';
import { FsHubError, type FsHubFlight } from '../src/fshub/client.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { COMPLETION_GRACE_MS } from '../src/services/jobs.js';
import { SheetWriteBack } from '../src/services/writeback.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeFsHub, FakeUser, fakeComponent, fakeDm, makeDiscordHarness, settle, type DiscordHarness, messageText } from './discord-helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up. The pilots, airlines and flights are not real. */

const AIRLINE_ID = 8123;
const NOW = T0 + 6 * HOUR;
const { account, publicKey } = makeServiceAccount();

describe('Complete on a panel linked to FsHub', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
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
  const press = async (user: FakeUser, customId: string, o: { values?: string[] } = {}) => {
    const f = fakeComponent(user, customId, o);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const complete = async (user = alice) => (await press(user, `panel:complete:${pid}`)).edits[0].content as string;
  const hold = (key: string, user: FakeUser = alice) => h.jobs.reserve(jobId(key), [1], { discordId: user.id, username: user.username });
  const bigReads = () => fshub.flightCalls.filter((c) => c.limit === 100).length;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = new FakeFsHub();
    fid = 4_900_000;
    d = makeDiscordHarness(h, { fshub }); // Alice (1001) and Bob (1002) already have FsHub pilot IDs
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

  it('is in FsHub mode only when the bot has a token, the panel is linked, and reading flights is on', () => {
    const panel = () => h.store.getPanel(pid)!;
    assert.equal(completesFromFsHub(d.ctx, panel()), true);
    h.store.updatePanel(pid, { fshubConfirm: false });
    assert.equal(completesFromFsHub(d.ctx, panel()), false, 'reading switched off');
    h.store.updatePanel(pid, { fshubConfirm: true, fshubAirlineId: null });
    assert.equal(completesFromFsHub(d.ctx, panel()), false, 'not linked');
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID });
    d.ctx.fshub = null;
    assert.equal(completesFromFsHub(d.ctx, panel()), false, 'no token');
  });

  describe('one press', () => {
    it('completes the flight FsHub shows flown, straight away: no menu, no confirming', async () => {
      hold('s');
      flown();
      const calls = await press(alice, `panel:complete:${pid}`);
      assert.deepEqual(calls.defers[0], { flags: 64 }, 'private to them');
      const text = calls.edits[0].content as string;
      assert.match(text, /✅ \*\*TST-001\*\* \(EGLL → EGKK\) is completed from FsHub: A320 \(Airbus A320\), landed <t:\d+:t> · on time\. Nice flying!/);
      assert.equal(calls.edits[0].components, undefined, 'nothing left to press');
      const j = job('s');
      assert.deepEqual([j.status, j.completedAt, j.completedBy, j.completedVia], ['expired', NOW, alice.id, 'fshub']);
      await settle(1700);
      const panelText = d.client.channel('700000000000000001').live.map((m) => messageText(m)).join('\n');
      assert.match(panelText, /^TST-001 · A320 · on time\n## EGLL ✈ EGKK\n\*Airbus A320\*\nFLOWN BY: <@\d+> · FsHub #1001\nLANDED: <t:\d+:t>\nFSHUB: \[flight #\d+\]/m);
    });

    it('reads FsHub itself, so a landing from a minute ago is there without waiting for the scheduled read', async () => {
      hold('s');
      assert.equal(fshub.flightCalls.length, 0);
      flown({ arrivedAt: NOW - 60_000, departedAt: NOW - HOUR });
      assert.match(await complete(), /✅ \*\*TST-001\*\*/);
      assert.ok(bigReads() >= 1);
    });

    it('says plainly when FsHub has not shown a flight, why, and what to do, and changes nothing', async () => {
      hold('s');
      const text = await complete();
      assert.match(text, /⏳ I can't see \*\*TST-001\*\* \(EGLL → EGKK\) on FsHub\. It has to have landed between <t:\d+:f> and <t:\d+:f>\./);
      assert.match(text, /shows up about a minute after landing, so if you have just landed, try again shortly/);
      assert.equal(job('s').completedAt, null);
      assert.equal(h.jobs.open(pid).some((v) => v.job.sourceKey === 's'), true, 'still open and still theirs');
    });

    it('completes what FsHub shows and reports what it does not, in one answer', async () => {
      hold('s');
      hold('t');
      flown();
      const text = await complete();
      assert.match(text, /✅ \*\*TST-001\*\*/);
      assert.match(text, /⏳ I can't see \*\*TST-002\*\* \(EGKK → EGCC\)/);
      assert.notEqual(job('s').completedAt, null);
      assert.equal(job('t').completedAt, null);
    });

    it('completes several at once', async () => {
      hold('s');
      hold('t');
      flown();
      flown({ dep: 'EGKK', arr: 'EGCC', aircraftIcao: 'B738', aircraftName: 'Boeing 737-800', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      const text = await complete();
      assert.match(text, /TST-001[\s\S]*is completed from FsHub[\s\S]*TST-002[\s\S]*is completed from FsHub/);
      assert.deepEqual([job('s').completedVia, job('t').completedVia], ['fshub', 'fshub']);
    });

    it('flags a different aircraft than the one scheduled, but still completes the flight', async () => {
      hold('s');
      flown({ aircraftIcao: 'B738', aircraftName: 'Boeing 737-800' });
      assert.match(await complete(), /✅ \*\*TST-001\*\*[^\n]*B738 \(Boeing 737-800\), landed <t:\d+:t> · on time · ⚠️ scheduled A320/);
      assert.notEqual(job('s').completedAt, null);
    });

    it('has nothing to do for a pilot who holds no flights', async () => {
      assert.match(await complete(), /You don't have a flight to complete\. Reserve one first/);
      assert.equal(fshub.flightCalls.length, 0, 'and FsHub was not asked');
    });

    it('leaves a flight that has not started yet alone, and does not trouble FsHub when none of them has', async () => {
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK'), windowed('later', 'EGPH-EGLL', { availableFrom: NOW + 5 * HOUR, deadline: NOW + 20 * HOUR })]);
      hold('later');
      assert.match(await complete(), /The flight you hold hasn't started yet, and FsHub can only show a flight once it has landed/);
      assert.equal(fshub.flightCalls.length, 0);
      hold('s');
      flown();
      const text = await complete();
      assert.match(text, /✅ \*\*TST-001\*\*/);
      assert.match(text, /1 other flight you hold hasn't started yet\./);
    });

    it('does not complete a flight someone else flew, even when theirs is the only flight on the route', async () => {
      hold('s');
      flown({ pilotId: 4242 });
      assert.match(await complete(), /⏳ I can't see \*\*TST-001\*\*/);
      assert.equal(job('s').completedAt, null);
    });

    it('needs the landing to be inside the flight\'s window (an hour either side)', async () => {
      hold('s');
      flown({ arrivedAt: T0 - 2 * HOUR, departedAt: T0 - 3 * HOUR });
      assert.match(await complete(), /⏳ I can't see \*\*TST-001\*\*/);
      flown({ arrivedAt: T0 - HOUR, departedAt: T0 - 2 * HOUR });
      fshub.flights.set(AIRLINE_ID, fshub.flights.get(AIRLINE_ID)!.slice(1));
      h.clock.now = NOW + 60_000;
      assert.match(await complete(), /✅ \*\*TST-001\*\*/);
    });

    it('does not let one FsHub flight complete two scheduled flights', async () => {
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK'), windowed('s2', 'EGLL-EGKK')]);
      hold('s');
      hold('s2');
      flown();
      const text = await complete();
      assert.equal((text.match(/✅/g) ?? []).length, 1);
      assert.equal((text.match(/⏳/g) ?? []).length, 1);
    });
  });

  describe('a flight with several legs', () => {
    beforeEach(() => {
      h.jobs.sync(pid, [windowed('m', 'LFPG-EHAM-EDDF')]);
    });

    it('is completed only when FsHub has shown every leg', async () => {
      hold('m');
      h.jobs.reserve(jobId('m'), [2], { discordId: alice.id, username: alice.username });
      flown({ dep: 'LFPG', arr: 'EHAM' });
      const code = job('m').code;
      const partial = await complete();
      assert.ok(partial.includes(`⏳ **${code}**: FsHub has shown 1 of its 2 legs so far.`), partial);
      assert.equal(job('m').completedAt, null);
      flown({ dep: 'EHAM', arr: 'EDDF', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR, aircraftIcao: 'B738', aircraftName: 'Boeing 737-800' });
      h.clock.now = NOW + 40_000;
      const full = await complete();
      assert.ok(full.includes(`✅ **${code}** (LFPG → EHAM → EDDF) is completed from FsHub: leg 1: A320 (Airbus A320), landed `), full);
      assert.match(full, /; leg 2: B738 \(Boeing 737-800\), landed/);
      assert.equal(job('m').completedVia, 'fshub');
    });
  });

  describe('whose flights are whose', () => {
    it('asks a pilot who has not given their FsHub ID for it, and changes nothing', async () => {
      const fresh = await makeHarness();
      const fd = makeDiscordHarness(fresh, { pilotIds: false, fshub: new FakeFsHub() });
      fresh.clock.now = NOW;
      fresh.store.updatePanel(fresh.panel.id, { fshubAirlineId: AIRLINE_ID });
      fresh.jobs.sync(fresh.panel.id, [windowed('s', 'EGLL-EGKK')]);
      const jid = fresh.store.listJobs(fresh.panel.id)[0]!.id;
      fresh.jobs.reserve(jid, [1], { discordId: alice.id, username: alice.username });
      const f = fakeComponent(alice, `panel:complete:${fresh.panel.id}`, {});
      await componentHandlers.find((x) => x.prefix === 'panel')!.handle(fd.ctx, f.i);
      assert.match(f.calls.edits[0].content, /I don't know your FsHub pilot ID yet.*DM me `fshub <your ID>`.*then press \*\*Complete\*\* again/);
      assert.equal(fresh.store.getJob(jid)!.completedAt, null);
      assert.equal((fd.ctx.fshub as FakeFsHub).flightCalls.length, 0, 'FsHub was not asked about flights');
      await settle(60);
      await fresh.close();
    });

    const OTHER_PILOT = '666666666666666666';
    /** A Discord account with no FsHub ID of its own yet (the test harness gives Alice, Bob and Carol one). */
    const newcomer = () => d.client.user(new FakeUser('555555555555555555', 'newcomer'));

    it('refuses an ID somebody typed when the airline roster says it belongs to another Discord account', async () => {
      const dave = newcomer();
      h.store.setPilotId(dave.id, 500, NOW, 'Roster Pilot'); // typed by him
      h.store.applyRosterLinks([{ discordId: OTHER_PILOT, fshubId: 500, name: 'Roster Pilot' }], NOW); // the roster says it is somebody else
      hold('s', dave);
      flown({ pilotId: 500 });
      const text = await complete(dave);
      assert.match(text, /roster lists FsHub pilot \*\*500\*\* as a different Discord account, so I can't complete flights for that ID from here/);
      assert.equal(job('s').completedAt, null);
      assert.equal(fshub.flightCalls.length, 0);
    });

    it('accepts an ID the roster itself gave the pilot', async () => {
      const carol = newcomer();
      h.store.applyRosterLinks([{ discordId: carol.id, fshubId: 500, name: 'Roster Pilot' }], NOW);
      hold('s', carol);
      flown({ pilotId: 500 });
      assert.match(await complete(carol), /✅ \*\*TST-001\*\*/);
    });

    it('accepts a typed ID that nobody else claims on the roster', async () => {
      const erin = newcomer();
      h.store.setPilotId(erin.id, 500, NOW, 'Some Pilot');
      hold('s', erin);
      flown({ pilotId: 500 });
      assert.match(await complete(erin), /✅ \*\*TST-001\*\*/);
    });

    it('does not let one pilot complete another pilot\'s flight', async () => {
      hold('s', bob);
      flown({ pilotId: 1002 });
      assert.match(await complete(alice), /You don't have a flight to complete/);
      assert.equal(job('s').completedAt, null);
      assert.match(await complete(bob), /✅ \*\*TST-001\*\*/);
    });
  });

  describe('when FsHub cannot be read', () => {
    it('says so, changes nothing, and does not fall back to taking their word for it', async () => {
      hold('s');
      flown();
      fshub.flightError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
      const calls = await press(alice, `panel:complete:${pid}`);
      assert.match(calls.edits[0].content, /I couldn't read FsHub just now: I couldn't reach FsHub right now\. Nothing was changed\. Try pressing \*\*Complete\*\* again in a few minutes\./);
      assert.equal(job('s').completedAt, null);
      fshub.flightError = null;
      assert.match(await complete(), /✅ \*\*TST-001\*\*/, 'and it works once FsHub is back');
    });
  });

  describe('how often FsHub is asked', () => {
    it('reuses flights read in the last half minute, and reads again after that', async () => {
      hold('s');
      flown();
      await complete(); // reads, and completes it
      const after = fshub.flightCalls.length;
      hold('t');
      await complete();
      assert.equal(fshub.flightCalls.length, after, 'within thirty seconds: no new request');
      h.clock.now = NOW + 31_000;
      await complete();
      assert.ok(fshub.flightCalls.length > after, 'after that it asks again');
    });

    it('shares one read between pilots pressing Complete together', async () => {
      hold('s');
      hold('t', bob);
      flown();
      flown({ pilotId: 1002, dep: 'EGKK', arr: 'EGCC' });
      const [a, b] = await Promise.all([press(alice, `panel:complete:${pid}`), press(bob, `panel:complete:${pid}`)]);
      assert.match(a.edits[0].content, /✅ \*\*TST-001\*\*/);
      assert.match(b.edits[0].content, /✅ \*\*TST-002\*\*/);
      assert.equal(bigReads(), 1, 'one read of the flights served both');
    });
  });

  describe('old buttons from before the panel was linked', () => {
    it('cannot complete a flight FsHub has not confirmed', async () => {
      hold('s');
      const pick = await press(alice, `panel:completepick:${pid}`, { values: [String(jobId('s'))] });
      assert.match(pick.updates[0].content, /Completing flights now works from FsHub\. Press \*\*Complete\*\* under the panel again/);
      assert.equal(pick.updates[0].components.length, 0);
      const yes = await press(alice, `panel:completeyes:${pid}:${jobId('s')}`);
      assert.match(yes.edits[0].content, /Completing flights now works from FsHub/);
      assert.equal(job('s').completedAt, null);
    });
  });

  describe('a completion FsHub confirmed is not undone by the schedule sheet', () => {
    /** The sheet is read again: the box for TST-001 is ticked or not, and the others are not ticked. */
    const sheetSays = (completed: boolean) =>
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK', { completed, aircraft: 'A320' }), windowed('t', 'EGKK-EGCC', { completed: false }), windowed('u', 'EGCC-EGPH', { completed: false })]);

    it('stays completed after the sheet is read again without a tick', async () => {
      hold('s');
      flown();
      await complete();
      h.clock.now = NOW + COMPLETION_GRACE_MS + HOUR;
      sheetSays(false);
      assert.notEqual(job('s').completedAt, null);
      assert.equal(job('s').completedVia, 'fshub');
      assert.equal(job('s').status, 'expired');
    });

    it('still follows the sheet when it is ticked', async () => {
      hold('s');
      flown();
      await complete();
      sheetSays(true);
      assert.notEqual(job('s').completedAt, null);
    });

    it('whereas a completion nobody confirmed is still undone after the grace period, as before', async () => {
      hold('t');
      h.jobs.complete(jobId('t'), alice.id);
      h.clock.now = NOW + COMPLETION_GRACE_MS + HOUR;
      sheetSays(false);
      assert.equal(job('t').completedAt, null);
    });
  });
});

describe('Complete when the panel is not working from FsHub', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let pid: number;
  const press = async (user: FakeUser, customId: string, o: { values?: string[] } = {}) => {
    const f = fakeComponent(user, customId, o);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const jobId = () => h.store.listJobs(pid)[0]!.id;
  const setUp = async (opts: { fshub: boolean; link: boolean; confirm?: boolean }) => {
    h = await makeHarness();
    h.clock.now = NOW;
    d = makeDiscordHarness(h, { fshub: opts.fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    pid = h.panel.id;
    if (opts.link) h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID, fshubConfirm: opts.confirm ?? true });
    h.jobs.sync(pid, [sj('s', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 12 * HOUR })]);
    h.jobs.reserve(jobId(), [1], { discordId: alice.id, username: alice.username });
  };
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const cases: Array<[string, { fshub: boolean; link: boolean; confirm?: boolean }]> = [
    ['no FsHub token', { fshub: false, link: false }],
    ['a token but the panel is not linked', { fshub: true, link: false }],
    ['a linked panel whose bot has lost its token', { fshub: false, link: true }],
    ['a linked panel with reading flights switched off', { fshub: true, link: true, confirm: false }],
  ];
  for (const [what, opts] of cases) {
    it(`is the pilot picking what they flew, and confirming, with ${what}`, async () => {
      await setUp(opts);
      const start = await press(alice, `panel:complete:${pid}`);
      const menu = start.edits[0].components[0].toJSON().components[0];
      assert.equal(menu.custom_id, `panel:completepick:${pid}`);
      assert.match(start.edits[0].content, /Which flights have you flown\?/);
      const pick = await press(alice, `panel:completepick:${pid}`, { values: [String(jobId())] });
      assert.match(pick.updates[0].content, /Mark \*\*TST-001\*\* as completed\?/);
      assert.doesNotMatch(pick.updates[0].content, /FsHub/);
      const confirm = pick.updates[0].components[0].toJSON().components[0].custom_id as string;
      const done = await press(alice, confirm);
      assert.match(done.edits[0].content, /✅ \*\*TST-001\*\* is completed\. Nice flying!/);
      const j = h.store.getJob(jobId())!;
      assert.deepEqual([j.completedBy, j.completedVia], [alice.id, null], 'a claim, not a confirmation');
      if (d.fshub) assert.equal(d.fshub.flightCalls.length, 0, 'and FsHub was never asked');
    });
  }
});

/* ------------------------------------------------------------------ with the airline's Google Sheet */

describe('Complete from FsHub on a panel whose schedule is a Google Sheet', () => {
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  const pid = () => h.panel.id;
  const SHEET_NOW = Date.UTC(2026, 10, 12, 20, 0); // the evening of the day TST-001 (EGLL-EGCC, 0600-2359z) is flown

  const syncFromSheet = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const job = (route: string) => {
    const [dep, arr] = route.split('-');
    return h.store.listJobs(pid()).find((j) => h.store.listLegs(j.id).some((l) => l.dep === dep && l.arr === arr))!;
  };
  const press = async (user: FakeUser, customId: string) => {
    const f = fakeComponent(user, customId, {});
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const reserve = async () => {
    await press(alice, `panel:reserve:${pid()}`);
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

  it('with write-back on, completes from FsHub and ticks the box in the sheet, as completing by hand does', async () => {
    await boot(true);
    await reserve();
    assert.equal(g.cell('E3'), 'alice');
    landed();
    const text = (await press(alice, `panel:complete:${pid()}`)).edits[0].content as string;
    assert.match(text, /✅ \*\*TST-001\*\* \(EGLL → EGCC\) is completed from FsHub: A320 \(Airbus A320\), landed <t:\d+:t> · on time and ticked in the airline's sheet\. Nice flying!/);
    assert.deepEqual([g.cell('E3'), g.cell('H3')], ['alice', 'TRUE']);
    assert.equal(job('EGLL-EGCC').completedVia, 'fshub');
  });

  it('with write-back on, does not complete a flight the sheet has given to someone else', async () => {
    await boot(true);
    await reserve();
    landed();
    g.values[2]![4] = 'Sam';
    const text = (await press(alice, `panel:complete:${pid()}`)).edits[0].content as string;
    assert.match(text, /⚠️ \*\*TST-001\*\* isn't completed: The sheet names \*\*Sam\*\* for that flight, so I haven't ticked it/);
    assert.equal(g.cell('H3'), 'FALSE');
    assert.equal(job('EGLL-EGCC').completedAt, null);
  });

  it('with no write-back, still completes on the panel (it used to refuse), says the sheet is not updated, and the next sheet read does not undo it', async () => {
    await boot(false);
    await reserve();
    landed();
    const text = (await press(alice, `panel:complete:${pid()}`)).edits[0].content as string;
    assert.match(text, /✅ \*\*TST-001\*\* \(EGLL → EGCC\) is completed from FsHub/);
    assert.doesNotMatch(text, /ticked in the airline's sheet/);
    assert.match(text, /ℹ️ I can't write to the airline's sheet, so it still shows those as not done there\. The panel is up to date\./);
    h.clock.now = SHEET_NOW + COMPLETION_GRACE_MS + HOUR;
    syncFromSheet(); // the sheet's box is still unticked
    assert.notEqual(job('EGLL-EGCC').completedAt, null);
    await d.panels.refresh(pid());
    const panelText = d.client.channel('700000000000000001').live.map((m) => messageText(m)).join('\n');
    assert.match(panelText, /^TST-001 ·/m);
  });

  it('without FsHub, a sheet panel that cannot be written to still refuses Complete, exactly as before', async () => {
    await boot(false);
    h.store.updatePanel(pid(), { fshubAirlineId: null });
    await reserve();
    await assert.rejects(press(alice, `panel:complete:${pid()}`), /keeps its flights in a Google Sheet, and I can't write to it/);
  });
});
