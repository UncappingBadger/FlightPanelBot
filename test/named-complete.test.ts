import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import type { FsHubFlight } from '../src/fshub/client.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { AutoCompleter } from '../src/services/autoComplete.js';
import { namedForOneOf, sameName, sheetNamesFor } from '../src/services/pilotNames.js';
import { SheetWriteBack } from '../src/services/writeback.js';
import { HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeFsHub, FakeUser, fakeComponent, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up. The pilots, airlines and flights are not real. */

const AIRLINE_ID = 8123;
const NOW = T0 + 6 * HOUR;
const { account, publicKey } = makeServiceAccount();

/** Complete, and the hourly check, for a flight somebody typed a pilot's name against in the airline's sheet. */
describe('a flight the sheet names for a pilot, who never pressed Reserve', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  let bob: FakeUser;
  let pid: number;
  let fid: number;

  /** A flight FsHub lists: by Alice (FsHub 1001), EGLL to EGKK, landed two hours ago, unless said otherwise. */
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
  /** A flight in the sheet with these names against its legs (one per leg; null for none). */
  const named = (key: string, chain: string, ...pilots: Array<string | null>) => {
    const a = chain.split('-');
    return sj(key, chain, { availableFrom: T0, deadline: T0 + 12 * HOUR, legs: a.slice(0, -1).map((dep, i) => ({ dep, arr: a[i + 1] as string, heldBy: pilots[i] ?? null })) });
  };
  const jobId = (key: string) => h.store.listJobs(pid).find((j) => j.sourceKey === key)!.id;
  const job = (key: string) => h.store.getJob(jobId(key))!;
  const panel = () => h.store.getPanel(pid)!;
  const press = async (user: FakeUser, customId: string) => {
    const f = fakeComponent(user, customId, {});
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const complete = async (user = alice) => (await press(user, `panel:complete:${pid}`)).edits[0].content as string;
  /** A Discord account with no FsHub ID of its own yet (the test harness gives Alice, Bob and Carol one). */
  const newcomer = (name = 'newcomer') => d.client.user(new FakeUser('555555555555555555', name));
  const sheetSays = (...flights: ReturnType<typeof named>[]) => h.jobs.sync(pid, flights);

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = new FakeFsHub();
    fid = 4_900_000;
    d = makeDiscordHarness(h, { fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    pid = h.panel.id;
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  describe('the Complete button', () => {
    it('completes it on FsHub\'s record of their own landing, makes it theirs, and says what it did', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Falcon'));
      assert.deepEqual(h.jobs.completable(pid, alice.id), [], 'before this, the bot had no idea it was theirs');
      flown();
      const text = await complete();
      assert.match(text, /✅ \*\*TST-001\*\* \(EGLL → EGKK\) is completed from FsHub: A320 \(Airbus A320\), landed <t:\d+:t> · on time\. Nice flying!/);
      assert.match(text, /ℹ️ The airline's sheet had \*\*Falcon\*\* against \*\*TST-001\*\*, a name I know you by, and FsHub shows you flew it, so I counted it as yours\./);
      const j = job('s');
      assert.deepEqual([j.status, j.completedAt, j.completedBy, j.completedVia], ['expired', NOW, alice.id, 'fshub']);
      const holder = h.store.getHolder(j.id, 1)!;
      assert.deepEqual([holder.discordId, holder.sheetName], [alice.id, 'Falcon'], 'the name in the sheet is now their reservation');
    });

    it('knows them by their Discord name when they have given none, whatever the capitals', async () => {
      sheetSays(named('s', 'EGLL-EGKK', 'Alice'));
      flown();
      assert.match(await complete(), /✅ \*\*TST-001\*\*/);
      assert.equal(job('s').completedBy, alice.id);
    });

    it('knows a name the bot wrote into the sheet for them before, even after they changed what they go by', async () => {
      sheetSays(named('s', 'EGLL-EGKK', 'Old Callsign'), named('t', 'EGKK-EGCC', null));
      h.jobs.reserve(jobId('t'), [1], { discordId: alice.id, username: alice.username });
      h.store.setReservationSheetName(jobId('t'), 1, 'Old Callsign');
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      flown();
      assert.match(await complete(), /✅ \*\*TST-001\*\*/);
    });

    it('does not take a flight named for somebody else, and tells a pilot how to say what the sheet calls them', async () => {
      sheetSays(named('s', 'EGLL-EGKK', 'Sam'));
      flown();
      const text = await complete();
      assert.match(text, /You don't have a flight to complete\. Reserve one first/);
      assert.match(text, /If your name is already against a flight in the airline's sheet, send me `name <your name as the sheet has it>` here, then press \*\*Complete\*\* again\./);
      assert.equal(job('s').completedAt, null);
      assert.equal(fshub.flightCalls.length, 0, 'FsHub was not even asked');
    });

    it('needs FsHub to show their own flight: somebody else\'s landing on the route does not complete it', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Falcon'));
      flown({ pilotId: 4242 });
      assert.match(await complete(), /⏳ I can't see \*\*TST-001\*\* \(EGLL → EGKK\) on FsHub/);
      const j = job('s');
      assert.equal(j.completedAt, null);
      assert.equal(h.store.getHolder(j.id, 1), null, 'and nothing was made theirs');
      assert.equal(h.store.listLegs(j.id)[0]!.sheetHolder, 'Falcon');
    });

    it('does nothing yet when FsHub has not shown a landing, and then works once it has', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Falcon'));
      assert.match(await complete(), /⏳ I can't see \*\*TST-001\*\*/);
      assert.equal(h.store.getHolder(jobId('s'), 1), null);
      flown({ arrivedAt: NOW - 60_000, departedAt: NOW - HOUR });
      h.clock.now = NOW + 40_000;
      assert.match(await complete(), /✅ \*\*TST-001\*\*/);
    });

    it('asks a pilot who has not given their FsHub ID for it, and changes nothing', async () => {
      const zed = newcomer('Zed');
      sheetSays(named('s', 'EGLL-EGKK', 'Zed'));
      assert.match(await complete(zed), /I don't know your FsHub pilot ID yet/);
      assert.equal(job('s').completedAt, null);
      assert.equal(h.store.getHolder(jobId('s'), 1), null);
    });

    it('refuses an ID somebody typed that the roster gives to another Discord account, as it does for a reserved flight', async () => {
      const dave = newcomer('Dave');
      h.store.setPilotId(dave.id, 500, NOW, 'Roster Pilot');
      h.store.applyRosterLinks([{ discordId: '666666666666666666', fshubId: 500, name: 'Roster Pilot' }], NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Dave'));
      flown({ pilotId: 500 });
      assert.match(await complete(dave), /roster lists FsHub pilot \*\*500\*\* as a different Discord account/);
      assert.equal(job('s').completedAt, null);
    });

    it('leaves a flight that somebody holds in Discord alone, whatever the sheet says', async () => {
      sheetSays(named('s', 'EGLL-EGKK', 'Alice'));
      h.store.insertReservation(jobId('s'), 1, bob.id, bob.username, NOW);
      flown();
      assert.match(await complete(alice), /You don't have a flight to complete/);
      assert.equal(job('s').completedAt, null);
      assert.equal(h.store.getHolder(jobId('s'), 1)!.discordId, bob.id);
    });

    it('treats a flight with several legs as theirs only when every leg is named for them', async () => {
      sheetSays(named('m', 'LFPG-EHAM-EDDF', 'Alice', 'Sam'));
      flown({ dep: 'LFPG', arr: 'EHAM' });
      assert.match(await complete(), /You don't have a flight to complete/);
      assert.equal(job('m').completedAt, null);

      sheetSays(named('m', 'LFPG-EHAM-EDDF', 'Alice', 'alice'));
      const text = await complete();
      assert.ok(text.includes(`⏳ **${job('m').code}**: FsHub has shown 1 of its 2 legs so far.`), text);
      flown({ dep: 'EHAM', arr: 'EDDF', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR, aircraftIcao: 'B738', aircraftName: 'Boeing 737-800' });
      h.clock.now = NOW + 40_000;
      assert.match(await complete(), /✅ \*\*TST-\d+\*\* \(LFPG → EHAM → EDDF\) is completed from FsHub: leg 1: A320/);
      assert.deepEqual([1, 2].map((n) => h.store.getHolder(jobId('m'), n)?.discordId), [alice.id, alice.id]);
    });

    it('is a safe guess because FsHub decides: two pilots who go by the same name cannot take each other\'s flight', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      h.store.setPilotName(bob.id, 'Falcon', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Falcon'));
      flown({ pilotId: 1002, pilotName: 'Bob Pilot' });
      assert.match(await complete(alice), /⏳ I can't see \*\*TST-001\*\*/, 'Alice has the name, but it was Bob who flew it');
      assert.equal(job('s').completedAt, null);
      assert.match(await complete(bob), /✅ \*\*TST-001\*\*/);
      assert.equal(job('s').completedBy, bob.id);
    });

    it('does not complete it twice', async () => {
      sheetSays(named('s', 'EGLL-EGKK', 'Alice'));
      flown();
      await complete();
      assert.match(await complete(), /You don't have a flight to complete/);
    });

    it('leaves a flight that has not started yet alone', async () => {
      sheetSays(sj('later', 'EGPH-EGLL', { availableFrom: NOW + 5 * HOUR, deadline: NOW + 20 * HOUR, legs: [{ dep: 'EGPH', arr: 'EGLL', heldBy: 'Alice' }] }));
      assert.match(await complete(), /The flight you hold hasn't started yet/);
      assert.equal(fshub.flightCalls.length, 0);
    });

    it('does not touch a reserved flight\'s completion, which still works as it did', async () => {
      sheetSays(named('s', 'EGLL-EGKK', null));
      h.jobs.reserve(jobId('s'), [1], { discordId: alice.id, username: alice.username });
      flown();
      const text = await complete();
      assert.match(text, /✅ \*\*TST-001\*\*/);
      assert.doesNotMatch(text, /ℹ️/);
    });
  });

  describe('the hourly check', () => {
    let ac: AutoCompleter;
    beforeEach(() => {
      ac = d.ctx.autoComplete!;
    });

    it('completes it for a pilot who has told the bot that name, and tells them how it came to be theirs', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Falcon'));
      flown();
      const r = await ac.runPanel(panel());
      assert.deepEqual(r.completed.map((c) => [c.view.job.code, c.discordId, c.namedAs]), [['TST-001', alice.id, 'Falcon']]);
      assert.deepEqual([job('s').completedBy, job('s').completedVia], [alice.id, 'fshub']);
      assert.equal(h.store.getHolder(jobId('s'), 1)!.sheetName, 'Falcon');
      assert.match(alice.lastText, /✅ \*\*TST-001\*\* \(EGLL → EGKK\): A320 \(Airbus A320\), landed <t:\d+:t> · on time · the airline's sheet had \*\*Falcon\*\* against it, a name I know you by/);
    });

    it('knows a name the bot wrote for them before', async () => {
      sheetSays(named('s', 'EGLL-EGKK', 'Old Callsign'), named('t', 'EGKK-EGCC', null));
      h.jobs.reserve(jobId('t'), [1], { discordId: alice.id, username: alice.username });
      h.store.setReservationSheetName(jobId('t'), 1, 'Old Callsign');
      flown();
      assert.equal((await ac.runPanel(panel())).completed.length, 1);
    });

    it('does not guess a name from Discord names it has never been told: only the Complete button, with the pilot there, does', async () => {
      sheetSays(named('s', 'EGLL-EGKK', 'Alice'));
      flown();
      const r = await ac.runPanel(panel());
      assert.deepEqual([r.completed.length, r.checked], [0, 0]);
      assert.equal(job('s').completedAt, null);
    });

    it('leaves a name two pilots go by alone, as nobody can say whose it is', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      h.store.setPilotName(bob.id, 'Falcon', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Falcon'));
      flown();
      assert.equal((await ac.runPanel(panel())).completed.length, 0);
      assert.equal(job('s').completedAt, null);
    });

    it('needs FsHub to show that pilot flying it', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Falcon'));
      flown({ pilotId: 1002 });
      const r = await ac.runPanel(panel());
      assert.deepEqual([r.completed.length, r.checked], [0, 1]);
      assert.equal(h.store.getHolder(jobId('s'), 1), null);
    });

    it('needs the pilot\'s FsHub ID to be known, and not given to somebody else by the roster', async () => {
      const zed = newcomer('Zed');
      h.store.setPilotName(zed.id, 'Zed', NOW);
      sheetSays(named('s', 'EGLL-EGKK', 'Zed'));
      flown();
      assert.equal((await ac.runPanel(panel())).checked, 0, 'no FsHub ID: not even a candidate');
      h.store.setPilotId(zed.id, 1001, NOW, 'Alice Pilot');
      h.store.applyRosterLinks([{ discordId: '666666666666666666', fshubId: 1001, name: 'Alice Pilot' }], NOW);
      assert.equal((await ac.runPanel(panel())).checked, 0, 'an ID the roster says is another account\'s');
      assert.equal(job('s').completedAt, null);
    });

    it('leaves a flight with several legs alone unless one pilot is named on every leg', async () => {
      h.store.setPilotName(alice.id, 'Falcon', NOW);
      h.store.setPilotName(bob.id, 'Hawk', NOW);
      sheetSays(named('m', 'LFPG-EHAM-EDDF', 'Falcon', 'Hawk'));
      flown({ dep: 'LFPG', arr: 'EHAM' });
      flown({ dep: 'EHAM', arr: 'EDDF', pilotId: 1002, arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      assert.equal((await ac.runPanel(panel())).completed.length, 0);
    });
  });
});

describe('a flight the sheet names for a pilot, with the airline\'s Google Sheet written to', () => {
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let alice: FakeUser;
  let fshub: FakeFsHub;
  const pid = () => h.panel.id;
  const SHEET_NOW = Date.UTC(2026, 10, 12, 20, 0); // the evening of the day TST-001 (EGLL-EGCC, 0600-2359z) is flown

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = SHEET_NOW;
    g = new FakeGoogle(publicKey);
    fshub = new FakeFsHub();
    const wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: wb, fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const syncFromSheet = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const landed = () =>
    fshub.flights.set(AIRLINE_ID, [
      { id: 4_900_001, pilotId: 1001, pilotName: 'Alice', dep: 'EGLL', arr: 'EGCC', departedAt: SHEET_NOW - 3 * HOUR, arrivedAt: SHEET_NOW - 2 * HOUR, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME' },
    ]);
  const press = async () => {
    const f = fakeComponent(alice, `panel:complete:${pid()}`, {});
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, f.i);
    return f.calls.edits[0].content as string;
  };

  it('ticks the box and leaves the sheet\'s own spelling of the name alone', async () => {
    g.values[2]![4] = 'ALICE';
    syncFromSheet();
    landed();
    const text = await press();
    assert.match(text, /✅ \*\*TST-001\*\* \(EGLL → EGCC\) is completed from FsHub: A320 \(Airbus A320\), landed <t:\d+:t> · on time and ticked in the airline's sheet\. Nice flying!/);
    assert.deepEqual([g.cell('E3'), g.cell('H3')], ['ALICE', 'TRUE']);
  });

  it('does not tick it when the sheet has moved on to somebody else since the bot last read it', async () => {
    g.values[2]![4] = 'alice';
    syncFromSheet();
    landed();
    g.values[2]![4] = 'Sam'; // changed in the sheet after the bot's last read
    const text = await press();
    assert.match(text, /⚠️ \*\*TST-001\*\* isn't completed: The sheet names \*\*Sam\*\* for that flight, so I haven't ticked it/);
    assert.equal(g.cell('H3'), 'FALSE');
    assert.equal(h.store.listJobs(pid()).find((j) => j.code === 'TST-001')!.completedAt, null);
    assert.equal(h.store.getHolder(h.store.listJobs(pid()).find((j) => j.code === 'TST-001')!.id, 1), null, 'and nothing was made theirs');
  });
});

describe('which names a pilot answers to', () => {
  it('is the name they gave, or else Discord\'s names for them, and any the bot wrote before, once each', async () => {
    const h = await makeHarness();
    const them = { id: USER_A.discordId, username: 'alice', globalName: 'Alice P' };
    assert.deepEqual(sheetNamesFor(h.store, them), ['Alice P', 'alice']);
    h.store.setPilotName(them.id, 'Falcon', T0);
    assert.deepEqual(sheetNamesFor(h.store, them), ['Falcon']);
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.store.listJobs(h.panel.id)[0]!.id, [1], { discordId: them.id, username: 'alice' });
    h.store.setReservationSheetName(h.store.listJobs(h.panel.id)[0]!.id, 1, 'falcon');
    h.store.setReservationSheetName(h.store.listJobs(h.panel.id)[0]!.id, 1, 'Old Name');
    assert.deepEqual(sheetNamesFor(h.store, them), ['Falcon', 'Old Name']);
    await h.close();
  });

  it('is the same name whatever the capitals or spaces at the ends', () => {
    assert.equal(sameName(' Falcon ', 'falcon'), true);
    assert.equal(sameName('Falcon', 'Falcon2'), false);
  });

  it('matches a flight only when nobody holds it and every leg is named for them', async () => {
    const h = await makeHarness();
    h.jobs.sync(h.panel.id, [
      sj('one', 'EGLL-EGKK', { legs: [{ dep: 'EGLL', arr: 'EGKK', heldBy: 'Falcon' }] }),
      sj('two', 'LFPG-EHAM-EDDF', { legs: [{ dep: 'LFPG', arr: 'EHAM', heldBy: 'Falcon' }, { dep: 'EHAM', arr: 'EDDF', heldBy: 'Sam' }] }),
      sj('none', 'EGKK-EGCC'),
    ]);
    const view = (key: string) => h.store.getJobView(h.store.listJobs(h.panel.id).find((j) => j.sourceKey === key)!.id)!;
    assert.deepEqual(namedForOneOf(view('one'), ['falcon']), ['Falcon']);
    assert.equal(namedForOneOf(view('one'), ['Sam']), null);
    assert.equal(namedForOneOf(view('one'), []), null);
    assert.equal(namedForOneOf(view('two'), ['Falcon']), null, 'the second leg is Sam\'s');
    assert.deepEqual(namedForOneOf(view('two'), ['Falcon', 'Sam']), ['Falcon', 'Sam']);
    assert.equal(namedForOneOf(view('none'), ['Falcon']), null, 'no name at all');
    h.store.insertReservation(view('one').job.id, 1, USER_B.discordId, 'bob', T0);
    assert.equal(namedForOneOf(view('one'), ['Falcon']), null, 'held in Discord');
    await h.close();
  });
});
