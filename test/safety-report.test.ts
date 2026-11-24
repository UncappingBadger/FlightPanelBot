import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Collection } from 'discord.js';
import type { FlownFlight } from '../src/db/store.js';
import { Notifier } from '../src/discord/notifier.js';
import type { PanelService } from '../src/discord/panel.js';
import type { HeldFlight } from '../src/services/airlineProfits.js';
import { AFTER_NOTICE_CLOSERS, AFTER_NOTICE_INTROS, composeRemark, HardLandings, SAFETY_FRESH_FOR_MS } from '../src/services/hardLanding.js';
import {
  appendPenaltyCsv,
  CSV_HEADER,
  csvField,
  csvLine,
  doubtMessage,
  flightNumberOf,
  HARD_LANDINGS_CSV,
  managerRoles,
  managersLookup,
  penaltyMessage,
  tellDoubts,
  utcText,
  type PenaltyReport,
} from '../src/services/safetyReport.js';
import { silentLogger } from '../src/util/log.js';
import { GUILD as SERVER, HOUR, sj, T0, USER_A, USER_B, makeHarness, type Harness } from './helpers.js';

/* Everything below is made up: the pilots, the airline and the flights. */

const NOW = T0 + 6 * HOUR;
const DAY = 24 * HOUR;
const BOM = '\uFEFF';
const MANAGER_1 = '810000000000000001';
const MANAGER_2 = '810000000000000002';

const report = (over: Partial<PenaltyReport> = {}): PenaltyReport => ({
  airline: 'Test Air',
  tier: 2,
  rate: -452,
  landedAt: Date.UTC(2026, 10, 22, 14, 5),
  pilotName: 'alice',
  fshubId: 1001,
  fshubUsername: 'Alice Pilot',
  flightNumber: 'TST216',
  dep: 'EGLL',
  arr: 'EGKK',
  flightId: 5_100_001,
  ...over,
});

/* ------------------------------------------------------------------ the CSV */

describe('the hard-landings CSV', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-csv-'));
    file = join(dir, 'data', HARD_LANDINGS_CSV);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is named hard-landings.csv', () => {
    assert.equal(HARD_LANDINGS_CSV, 'hard-landings.csv');
  });

  it('has the columns in the order the airline asked for, then the tier, the airline and FsHub\'s own flight number', () => {
    assert.deepEqual([...CSV_HEADER], ['Pilot Name', 'FsHub ID', 'FsHub Username (if different)', 'Flight Number', 'Departure-Arrival', 'Landed (UTC)', 'Landing Rate (fpm)', 'Tier', 'Airline', 'FsHub Flight ID']);
  });

  it('is one line a landing: the pilot, FsHub ID and name, flight number, route, time of landing in UTC and the rate', () => {
    assert.equal(csvLine(report()), 'alice,1001,Alice Pilot,TST216,EGLL-EGKK,2026-11-22 14:05,-452,Tier 2,Test Air,5100001');
    assert.equal(utcText(Date.UTC(2026, 0, 3, 9, 7)), '2026-01-03 09:07');
  });

  it('leaves the FsHub username and the flight number blank when there is none', () => {
    assert.equal(csvLine(report({ fshubUsername: null, flightNumber: null })), 'alice,1001,,,EGLL-EGKK,2026-11-22 14:05,-452,Tier 2,Test Air,5100001');
  });

  it('is created with a heading (and the mark that lets Excel read accents) the first time, and only the heading once', () => {
    appendPenaltyCsv(file, report());
    appendPenaltyCsv(file, report({ flightId: 5_100_002, tier: 3, rate: -710, pilotName: 'Zoë' }));
    const text = readFileSync(file, 'utf8');
    assert.ok(text.startsWith(BOM));
    assert.deepEqual(text.slice(1).split('\r\n'), [
      CSV_HEADER.join(','),
      'alice,1001,Alice Pilot,TST216,EGLL-EGKK,2026-11-22 14:05,-452,Tier 2,Test Air,5100001',
      'Zoë,1001,Alice Pilot,TST216,EGLL-EGKK,2026-11-22 14:05,-710,Tier 3,Test Air,5100002',
      '',
    ]);
  });

  it('makes the folder if it is not there, and adds to a file that is', () => {
    assert.equal(existsSync(join(dir, 'data')), false);
    appendPenaltyCsv(file, report());
    assert.equal(existsSync(file), true);
    appendPenaltyCsv(file, report({ flightId: 2 }));
    assert.equal(readFileSync(file, 'utf8').split('\r\n').filter((l) => l !== '').length, 3);
  });

  it('quotes a field with a comma or a quote, and keeps a name on one line', () => {
    assert.equal(csvField('Smith, Alice'), '"Smith, Alice"');
    assert.equal(csvField('The "Ace"'), '"The ""Ace"""');
    assert.equal(csvField('two\nlines'), 'two lines');
    assert.equal(csvField(null), '');
    assert.equal(csvField(-452), '-452');
  });

  it('puts a text a spreadsheet would run as a formula behind an apostrophe, since names come from outside', () => {
    for (const bad of ['=SUM(A1)', '+1', '-2+3', '@x', '\tx']) assert.equal(csvField(bad), `'${bad}`, bad);
    assert.equal(csvField('Alice -1'), 'Alice -1');
    assert.match(csvLine(report({ pilotName: '=HYPERLINK("x")', flightNumber: '@A1' })), /^"'=HYPERLINK\(""x""\)",1001,Alice Pilot,'@A1,/);
    assert.equal(csvField(-452), '-452', 'the rate is a number, not text, and is left as it is');
  });

  it('throws when the file cannot be written, so the caller knows to try again', () => {
    mkdirSync(file, { recursive: true }); // a folder where the file should be
    assert.throws(() => appendPenaltyCsv(file, report()));
  });
});

/* ------------------------------------------------------------------ the messages */

describe('what managers are sent', () => {
  it('reports a penalty landing: pilot, FsHub ID and name, flight, route, time and rate', () => {
    const text = penaltyMessage(report(), true, true);
    assert.match(text, /^🚨 \*\*Safety violation, Tier 2\*\* · Test Air\n/);
    assert.match(text, /\*\*Pilot:\*\* \*\*alice\*\* · FsHub ID 1001 · FsHub username Alice Pilot\n/);
    assert.match(text, /\*\*Flight:\*\* TST216 · EGLL → EGKK\n/);
    assert.match(text, /\*\*Landed:\*\* <t:\d+:f> \(2026-11-22 14:05 UTC\)\n/);
    assert.match(text, /\*\*Landing rate:\*\* -452 fpm\n/);
    assert.match(text, /8% of the profit instead of 15%/);
    assert.match(text, /The pilot has been sent the safety notice\./);
    assert.match(text, /Added to hard-landings\.csv in my data folder\./);
  });

  it('uses the Tier 3 sign and share, and leaves out the FsHub username when there is none', () => {
    const text = penaltyMessage(report({ tier: 3, fshubUsername: null }), true, true);
    assert.match(text, /^🛑 \*\*Safety violation, Tier 3\*\*/);
    assert.match(text, /5% of the profit/);
    assert.doesNotMatch(text, /FsHub username/);
  });

  it('says when the flight could not be matched to the schedule', () => {
    assert.match(penaltyMessage(report({ flightNumber: null }), true, true), /\*\*Flight:\*\* EGLL → EGKK \(not matched to a flight in the schedule\)/);
  });

  it('says whether the pilot was told, could not be, or is not linked to Discord', () => {
    assert.match(penaltyMessage(report(), false, true), /couldn't be sent the safety notice \(closed DMs, perhaps\)/);
    assert.match(penaltyMessage(report(), null, true), /isn't linked to a Discord account, so they were not sent the safety notice/);
  });

  it('says when the CSV could not be written, and says nothing about it where none is kept', () => {
    assert.match(penaltyMessage(report(), true, false), /couldn't add it to hard-landings\.csv \(is the file open in another program\?\)\. I'll try again\./);
    assert.doesNotMatch(penaltyMessage(report(), true, null), /csv/i);
  });

  it('has a heading and flight that cannot break the message, however long or odd the names are', () => {
    const text = penaltyMessage(report({ pilotName: '*'.repeat(200), airline: 'A'.repeat(200), flightNumber: '_'.repeat(100) }), true, true);
    assert.ok(text.length < 1900, `${text.length}`);
  });

  const held = (over: Partial<HeldFlight> = {}): HeldFlight => ({
    sourceKey: 'k1',
    row: 12,
    route: 'EGLL → EGCC',
    day: Date.UTC(2026, 10, 21),
    callsign: 'TST216',
    pilot: 'Alex',
    flightId: 5000,
    reason: 'no-landing-rate',
    fpm: null,
    ...over,
  });

  it('tells managers which flights were left unfilled and why, and asks them to fill the cells by hand', () => {
    const text = doubtMessage('Test Air', [held(), held({ sourceKey: 'k2', callsign: 'TST300', route: 'KMIA → KORD', reason: 'landing-rate-not-believed', fpm: 3100, pilot: '' })]);
    assert.match(text, /^⏸️ \*\*Safety pay: left unfilled\*\* · Test Air\n/);
    assert.match(text, /I haven't filled in the Profit Made or Pilot Pay cells:/);
    assert.match(text, /• \*\*TST216\*\* EGLL → EGCC, 21 Nov, pilot in the sheet: Alex: FsHub has no landing rate for it\./);
    assert.match(text, /• \*\*TST300\*\* KMIA → KORD, 21 Nov: FsHub's landing rate for it \(-3100 fpm\) is too hard to believe as a touchdown\./);
    assert.match(text, /fill the cells in by hand/);
  });

  it('says it in the singular for one flight, and counts the ones it does not list', () => {
    assert.match(doubtMessage('Test Air', [held()]), /whether this flight should have the pay cut/);
    const many = doubtMessage('Test Air', Array.from({ length: 11 }, (_, i) => held({ sourceKey: `k${i}`, callsign: `TST${i}` })));
    assert.match(many, /…and 3 more\./);
    assert.ok(many.length < 1900, `${many.length}`);
  });
});

/* ------------------------------------------------------------------ who the managers are */

describe('who the managers are', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('is nobody until a role is set', () => {
    assert.deepEqual(managerRoles(h.store, h.panel), []);
  });

  it('is the roles that can run /setup refresh and the role that can write profits, each once', () => {
    h.store.addRefreshRole(h.panel.guildId, MANAGER_1, NOW);
    h.store.addRefreshRole(h.panel.guildId, MANAGER_2, NOW);
    h.store.updatePanel(h.panel.id, { profitRoleId: MANAGER_2 });
    assert.deepEqual(managerRoles(h.store, h.store.getPanel(h.panel.id)!), [MANAGER_1, MANAGER_2]);
    h.store.updatePanel(h.panel.id, { profitRoleId: '820000000000000003' });
    assert.deepEqual(managerRoles(h.store, h.store.getPanel(h.panel.id)!), [MANAGER_1, MANAGER_2, '820000000000000003']);
  });
});

/* ------------------------------------------------------------------ which flight it was */

describe('which schedule flight a landing was', () => {
  let h: Harness;
  const pid = () => h.panel.id;
  const windowed = (key: string, chain: string) => sj(key, chain, { availableFrom: T0, deadline: T0 + 12 * HOUR });
  const jobOf = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!;
  const landing = (over: Partial<FlownFlight> = {}): FlownFlight => ({
    flightId: 5_100_001,
    pilotId: 1001,
    pilotName: 'Alice Pilot',
    dep: 'EGLL',
    arr: 'EGKK',
    departedAt: NOW - 2 * HOUR,
    arrivedAt: NOW - 10 * 60_000,
    aircraftIcao: 'A320',
    aircraftName: 'Airbus A320',
    scheduleStatus: null,
    landingRate: -450,
    ...over,
  });
  const where = (f: FlownFlight) => flightNumberOf(h.store, h.store.getPanel(pid())!, f, NOW);
  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    h.store.setPilotId(USER_A.discordId, 1001, NOW);
    h.store.setPilotId(USER_B.discordId, 1002, NOW);
  });
  afterEach(() => h.close());

  it('is the code of the flight the pilot holds between those airports, landed inside its window', () => {
    h.jobs.sync(pid(), [windowed('s', 'EGLL-EGKK')]);
    h.jobs.reserve(jobOf('s').id, [1], USER_A);
    assert.equal(where(landing()), jobOf('s').code);
  });

  it('is nothing when the pilot does not hold it, it is another route, or the landing was outside its window', () => {
    h.jobs.sync(pid(), [windowed('s', 'EGLL-EGKK')]);
    h.jobs.reserve(jobOf('s').id, [1], USER_A);
    assert.equal(where(landing({ pilotId: 1002 })), null, 'somebody else flew that route');
    assert.equal(where(landing({ dep: 'EGKK', arr: 'EGLL' })), null, 'another route');
    assert.equal(where(landing({ arrivedAt: T0 + 40 * HOUR })), null, 'after the window');
    assert.equal(where(landing({ arrivedAt: T0 - 10 * HOUR })), null, 'before the window');
    assert.equal(where(landing({ pilotId: 99999 })), null, 'a pilot the bot does not know');
  });

  it('is the flight the pilot stands by for, when they are the backup', () => {
    h.jobs.sync(pid(), [windowed('s', 'EGLL-EGKK')]);
    h.jobs.reserve(jobOf('s').id, [1], USER_A);
    h.jobs.addBackup(jobOf('s').id, USER_B);
    assert.equal(where(landing({ pilotId: 1002 })), jobOf('s').code);
  });

  it('is still found once the flight has been completed', () => {
    h.jobs.sync(pid(), [windowed('s', 'EGLL-EGKK')]);
    h.jobs.reserve(jobOf('s').id, [1], USER_A);
    h.jobs.complete(jobOf('s').id, USER_A.discordId);
    assert.equal(where(landing()), jobOf('s').code);
  });

  it('names every flight that fits when more than one does', () => {
    h.jobs.sync(pid(), [windowed('s', 'EGLL-EGKK'), windowed('t', 'EGLL-EGKK')]);
    h.jobs.reserve(jobOf('s').id, [1], USER_A);
    h.jobs.reserve(jobOf('t').id, [1], USER_A);
    const text = where(landing())!;
    assert.match(text, / or /);
    assert.ok(text.includes(jobOf('s').code) && text.includes(jobOf('t').code));
  });

  it('takes the airline\'s own flight number when the sheet has one', () => {
    h.jobs.sync(pid(), [windowed('s', 'EGLL-EGKK')]);
    const id = jobOf('s').id;
    h.jobs.reserve(id, [1], USER_A);
    assert.match(where(landing())!, /^[A-Z0-9-]+$/);
  });
});

/* ------------------------------------------------------------------ what happens when a pilot lands hard */

describe('when a pilot lands hard for an airline with safety pay on', () => {
  let h: Harness;
  let dir: string;
  let file: string;
  let sent: Array<{ to: string; content: string }>;
  let reachable: Set<string> | null;
  let people: string[];
  let names: Map<string, string>;
  let svc: HardLandings;
  let fid: number;
  const rows = () => readFileSync(file, 'utf8').replace(BOM, '').split('\r\n').filter((l) => l !== '').slice(1);
  const flight = (over: Partial<FlownFlight> = {}): FlownFlight => ({
    flightId: ++fid,
    pilotId: 1001,
    pilotName: 'Alice Pilot',
    dep: 'EGLL',
    arr: 'EGKK',
    departedAt: NOW - 2 * HOUR,
    arrivedAt: NOW - 10 * 60_000,
    aircraftIcao: 'A320',
    aircraftName: 'Airbus A320',
    scheduleStatus: 'ON-TIME',
    landingRate: -450,
    ...over,
  });
  const panel = () => h.store.getPanel(h.panel.id)!;
  const check = (...flights: FlownFlight[]) => svc.check(panel(), flights);
  const turnOn = (minimumLoss = 0, since = NOW - DAY) => h.store.updatePanel(h.panel.id, { safetyPaySince: since, safetyLossTier2: minimumLoss, safetyLossTier3: minimumLoss });
  const make = (o: { managers?: boolean; csv?: boolean; nameOf?: boolean } = {}) =>
    new HardLandings(
      h.store,
      async (id, content) => {
        if (reachable !== null && !reachable.has(id)) return false;
        sent.push({ to: id, content });
        return true;
      },
      {
        now: () => h.clock.now,
        ...(o.managers === false ? {} : { managers: async () => people }),
        ...(o.nameOf === false ? {} : { nameOf: async (id: string) => names.get(id) ?? null }),
        csvFile: o.csv === false ? null : file,
      },
    );

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    dir = mkdtempSync(join(tmpdir(), 'fpb-hl-'));
    file = join(dir, HARD_LANDINGS_CSV);
    sent = [];
    reachable = null;
    people = [MANAGER_1, MANAGER_2];
    names = new Map([[USER_A.discordId, 'alice']]);
    fid = 5_100_000;
    h.store.setPilotId(USER_A.discordId, 1001, NOW);
    svc = make();
    turnOn();
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await h.close();
  });

  it('sends the pilot the safety notice, then the managers the report, and adds a row to the CSV, for a Tier 2 landing', async () => {
    const f = flight({ landingRate: -452 });
    assert.equal(await check(f), 3);
    assert.deepEqual(sent.map((s) => s.to), [USER_A.discordId, MANAGER_1, MANAGER_2], 'the pilot first, then the managers');
    assert.match(sent[0]!.content, /Tier 2 Safety Violation[^]*-452 fpm/);
    assert.match(sent[1]!.content, /^🚨 \*\*Safety violation, Tier 2\*\* · Test Air/);
    assert.equal(sent[1]!.content, sent[2]!.content, 'the same report to each manager');
    assert.deepEqual(rows(), [`alice,1001,Alice Pilot,,EGLL-EGKK,${utcText(f.arrivedAt)},-452,Tier 2,Test Air,${f.flightId}`]);
    assert.match(sent[1]!.content, /Added to hard-landings\.csv in my data folder\./);
  });

  it('reports the pilot\'s Discord name, the FsHub ID, and the FsHub name only when it is different', async () => {
    await check(flight());
    assert.match(sent[1]!.content, /\*\*Pilot:\*\* \*\*alice\*\* · FsHub ID 1001 · FsHub username Alice Pilot\n/);
    names.set(USER_A.discordId, 'alice pilot'); // the same name, in other letters
    await check(flight({ flightId: 6 }));
    assert.match(sent.at(-1)!.content, /\*\*Pilot:\*\* \*\*alice pilot\*\* · FsHub ID 1001\n/);
    assert.equal(rows().at(-1)!.split(',')[2], '', 'no FsHub username in the CSV either');
  });

  it('falls back to FsHub\'s name for the pilot when the bot can\'t find their Discord name', async () => {
    names.clear();
    await check(flight());
    assert.match(sent[1]!.content, /\*\*Pilot:\*\* \*\*Alice Pilot\*\* · FsHub ID 1001\n/);
    assert.deepEqual(rows()[0]!.split(',').slice(0, 3), ['Alice Pilot', '1001', '']);
    const unnamed = flight({ pilotName: null, flightId: 7 });
    await check(unnamed);
    assert.equal(rows().at(-1)!.split(',')[0], 'FsHub pilot 1001');
  });

  it('names the schedule flight when it can tell which one it was', async () => {
    h.jobs.sync(h.panel.id, [sj('s', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 12 * HOUR })]);
    const job = h.store.listJobs(h.panel.id)[0]!;
    h.jobs.reserve(job.id, [1], USER_A);
    await check(flight());
    assert.match(sent[1]!.content, new RegExp(`\\*\\*Flight:\\*\\* ${job.code} · EGLL → EGKK`));
    assert.equal(rows()[0]!.split(',')[3], job.code);
  });

  it('does the same for Tier 3, with its own notice', async () => {
    assert.equal(await check(flight({ landingRate: -650 })), 4, 'the notice, two reports, and the remark that follows');
    assert.match(sent[0]!.content, /Tier 3 Critical Safety Violation/);
    assert.match(sent[1]!.content, /Safety violation, Tier 3/);
    assert.match(rows()[0]!, /,-650,Tier 3,/);
  });

  it('says each tier\'s own percentage of the minimum in the notice, when the airline set the tiers apart', async () => {
    h.store.updatePanel(h.panel.id, { safetyLossTier2: 10, safetyLossTier3: 40 });
    await check(flight({ landingRate: -450 }), flight({ landingRate: -650 }));
    const notices = sent.filter((s) => s.to === USER_A.discordId && /Safety Violation/.test(s.content));
    assert.equal(notices.length, 2);
    assert.match(notices[0]!.content, /Tier 2 Safety Violation[^]*takes 10% off the \$2,000 minimum pay/);
    assert.match(notices[1]!.content, /Tier 3 Critical Safety Violation[^]*takes 40% off the \$2,000 minimum pay/);
    h.store.updatePanel(h.panel.id, { safetyLossTier2: 0, safetyLossTier3: 100 });
    sent = [];
    await check(flight({ landingRate: -450, flightId: 6_100_001 }), flight({ landingRate: -650, flightId: 6_100_002 }));
    const later = sent.filter((s) => s.to === USER_A.discordId && /Safety Violation/.test(s.content));
    assert.match(later[0]!.content, /The airline's \$2,000 minimum pay still applies to this flight\./);
    assert.match(later[1]!.content, /takes all of the \$2,000 minimum pay/);
  });

  it('sends only the warning for a Tier 1 landing: nothing to the managers, nothing in the CSV', async () => {
    assert.equal(await check(flight({ landingRate: -380 })), 1);
    assert.deepEqual(sent.map((s) => s.to), [USER_A.discordId]);
    assert.match(sent[0]!.content, /Tier 1 Safety Warning/);
    assert.equal(existsSync(file), false);
  });

  it('sends nothing for a landing gentler than Tier 1, one with no rate, or one too hard to believe', async () => {
    assert.equal(await check(flight({ landingRate: -374 }), flight({ landingRate: null }), flight({ landingRate: 0 }), flight({ landingRate: -3000 })), 0);
    assert.deepEqual(sent, []);
    assert.equal(existsSync(file), false);
  });

  it('sends nothing for a landing from before safety pay was turned on, or older than three days', async () => {
    turnOn(0, NOW - 5 * 60_000);
    assert.equal(await check(flight({ arrivedAt: NOW - 10 * 60_000 })), 0, 'before it was turned on');
    turnOn(0, NOW - 10 * DAY);
    assert.equal(await check(flight({ arrivedAt: NOW - SAFETY_FRESH_FOR_MS - HOUR })), 0, 'too old');
    assert.equal(await check(flight({ arrivedAt: NOW - 2 * DAY, landingRate: -450 })) > 0, true, 'two days is still fresh');
  });

  it('does each thing once for a flight, however often it is read, and one row a flight', async () => {
    const f = flight();
    assert.equal(await check(f), 3);
    assert.equal(await check(f), 0);
    assert.equal(sent.length, 3);
    assert.equal(rows().length, 1);
  });

  it('sends the safety notice and the report whatever the pilot has switched off with `notifications`', async () => {
    h.store.setNotice(USER_A.discordId, 'landing', false, NOW);
    h.store.setNotice(USER_A.discordId, 'takeoff', false, NOW);
    h.store.setNotice(USER_A.discordId, 'completed', false, NOW);
    assert.equal(await check(flight({ landingRate: -450 })), 3);
    assert.equal(await check(flight({ landingRate: -500 })), 3, 'with no pause after the last');
  });

  it('still reports a landing by a pilot who is not linked to a Discord account, and says so', async () => {
    const stranger = flight({ pilotId: 99999, pilotName: 'Sam Stranger' });
    assert.equal(await check(stranger), 2, 'just the two managers');
    assert.deepEqual(sent.map((s) => s.to), [MANAGER_1, MANAGER_2]);
    assert.match(sent[0]!.content, /\*\*Pilot:\*\* \*\*Sam Stranger\*\* · FsHub ID 99999/);
    assert.match(sent[0]!.content, /isn't linked to a Discord account, so they were not sent the safety notice/);
    assert.equal(rows().length, 1);
  });

  it('sends the notice to a pilot who links later, but does not report or log the flight again', async () => {
    const stranger = flight({ pilotId: 4004, pilotName: 'Late Linker' });
    await check(stranger);
    sent = [];
    h.store.setPilotId(USER_B.discordId, 4004, NOW);
    assert.equal(await check(stranger), 1);
    assert.deepEqual(sent.map((s) => s.to), [USER_B.discordId]);
    assert.equal(rows().length, 1);
  });

  it('says the pilot could not be sent the notice when their DMs are closed, and does not try again', async () => {
    reachable = new Set([MANAGER_1, MANAGER_2]);
    const f = flight();
    assert.equal(await check(f), 2);
    assert.match(sent[0]!.content, /couldn't be sent the safety notice/);
    reachable = null;
    assert.equal(await check(f), 0, 'not tried again');
    assert.equal(rows().length, 1, 'but the row is in the CSV');
  });

  it('keeps the CSV row, and the notice to the pilot, when no manager can be told', async () => {
    people = [];
    assert.equal(await check(flight()), 1);
    assert.equal(rows().length, 1);
    people = [MANAGER_1];
    assert.equal(await check(flight({ flightId: 5_200_000 })), 2, 'a later landing reaches the managers when there are some');
  });

  it('does not go wrong when the lookup of the managers fails: the pilot is told and the row is kept', async () => {
    const broken = new HardLandings(h.store, async (id, content) => (sent.push({ to: id, content }), true), {
      now: () => h.clock.now,
      managers: async () => {
        throw new Error('discord is on fire');
      },
      csvFile: file,
    });
    assert.equal(await broken.check(panel(), [flight()]), 1);
    assert.equal(rows().length, 1);
  });

  it('adds the row later, and does not report twice, when the file could not be written the first time', async () => {
    mkdirSync(file, { recursive: true }); // a folder where the file should be: nothing can be written
    const f = flight();
    assert.equal(await check(f), 3);
    assert.match(sent[1]!.content, /couldn't add it to hard-landings\.csv/);
    assert.equal(h.store.getSafetyLanding(h.panel.id, f.flightId)!.logged, false);
    assert.equal(h.store.getSafetyLanding(h.panel.id, f.flightId)!.reported, true);
    rmSync(file, { recursive: true, force: true });
    sent = [];
    assert.equal(await check(f), 0, 'no second message to anyone');
    assert.equal(rows().length, 1, 'the row is written now');
    assert.equal(h.store.getSafetyLanding(h.panel.id, f.flightId)!.logged, true);
  });

  it('keeps no file and sends no report when it has neither to use, and says nothing of a CSV', async () => {
    svc = make({ csv: false });
    assert.equal(await check(flight()), 3);
    assert.doesNotMatch(sent[1]!.content, /csv/i);
    sent = [];
    rmSync(file, { force: true });
    svc = make({ managers: false });
    assert.equal(await check(flight({ flightId: 6_000_000 })), 1, 'only the pilot');
    assert.equal(rows().length, 1);
  });

  it('does nothing extra for an airline with safety pay off: no notice, no report, no file, and the old remark', async () => {
    h.store.updatePanel(h.panel.id, { safetyPaySince: null });
    assert.equal(await check(flight({ landingRate: -900 })), 1);
    assert.match(sent[0]!.content, /^☕ \*\*Kevin, Scheduler\*\*/);
    for (const intro of AFTER_NOTICE_INTROS) assert.ok(!sent[0]!.content.includes(intro));
    assert.equal(existsSync(file), false);
    assert.deepEqual(sent.map((s) => s.to), [USER_A.discordId]);
  });

  describe('the light-hearted remark that follows', () => {
    it('comes after the safety notice and the report, in gentler words, for a landing of -600 or harder', async () => {
      const f = flight({ landingRate: -900 });
      assert.equal(await check(f), 4);
      assert.deepEqual(sent.map((s) => s.to), [USER_A.discordId, MANAGER_1, MANAGER_2, USER_A.discordId], 'the airline\'s message first, the joke last');
      assert.match(sent[0]!.content, /Tier 3 Critical Safety Violation/);
      assert.equal(sent[3]!.content, composeRemark({ rate: -900, route: 'EGLL → EGKK', aircraft: 'A320', airline: 'Test Air', flightId: f.flightId, afterNotice: true }));
      assert.match(sent[3]!.content, /^☕ \*\*Kevin, Scheduler\*\*\n/);
    });

    it('opens by saying it is the unofficial message, and closes by sending the pilot off kindly', () => {
      for (let id = 1; id <= 40; id++) {
        const text = composeRemark({ rate: -700, route: 'EGLL → EGKK', aircraft: 'A320', airline: 'Test Air', flightId: id, afterNotice: true });
        const lines = text.split('\n');
        assert.ok(AFTER_NOTICE_INTROS.includes(lines[1]!), `intro ${id}`);
        assert.ok(AFTER_NOTICE_CLOSERS.includes(lines[3]!), `closer ${id}`);
        assert.equal(lines[4], '— Kevin');
      }
    });

    it('is the same remark as before, with nothing added, when there was no notice', () => {
      const plain = composeRemark({ rate: -700, route: 'EGLL → EGKK', aircraft: 'A320', airline: 'Test Air', flightId: 3 });
      const after = composeRemark({ rate: -700, route: 'EGLL → EGKK', aircraft: 'A320', airline: 'Test Air', flightId: 3, afterNotice: true });
      assert.equal(plain.split('\n').length, 4);
      assert.ok(after.includes(plain.split('\n')[1]!), 'the same joke inside');
      assert.equal(after.split('\n').length, 6);
    });

    it('has intros and closers that are kind, finished and short, with no repeats', () => {
      for (const list of [AFTER_NOTICE_INTROS, AFTER_NOTICE_CLOSERS]) {
        assert.ok(list.length >= 5);
        assert.equal(new Set(list).size, list.length);
        for (const line of list) {
          assert.ok(line.length <= 200, line);
          assert.doesNotMatch(line, /[{}]/, line);
        }
      }
    });

    it('is not sent for a Tier 2 landing, which is under -600', async () => {
      assert.equal(await check(flight({ landingRate: -500 })), 3);
      assert.ok(sent.every((s) => !s.content.startsWith('☕')));
    });

    it('can still be switched off by the pilot, and the notice and report still go out', async () => {
      h.store.setNotice(USER_A.discordId, 'landing', false, NOW);
      assert.equal(await check(flight({ landingRate: -900 })), 3);
      assert.ok(sent.every((s) => !s.content.startsWith('☕')));
    });

    it('keeps its quiet time: one remark in six hours, though every notice is sent', async () => {
      assert.equal(await check(flight({ landingRate: -900 })), 4);
      sent = [];
      assert.equal(await check(flight({ landingRate: -900 })), 3, 'the notice and the two reports, but no second joke');
      assert.ok(sent.every((s) => !s.content.startsWith('☕')));
    });

    it('is sent only for a landing from the last three hours, as ever, though the notice is sent for a landing from days ago', async () => {
      turnOn(0, NOW - 10 * DAY);
      assert.equal(await check(flight({ landingRate: -900, arrivedAt: NOW - DAY })), 3);
      assert.ok(sent.every((s) => !s.content.startsWith('☕')));
    });

    it('is not sent when the pilot cannot be told anything because they are not linked', async () => {
      assert.equal(await check(flight({ pilotId: 99999, landingRate: -900 })), 2);
      assert.ok(sent.every((s) => !s.content.startsWith('☕')));
    });
  });
});

/* ------------------------------------------------------------------ flights left unfilled */

describe('telling managers about flights left unfilled', () => {
  let h: Harness;
  let sent: Array<{ to: string; content: string }>;
  let people: string[];
  const held = (key: string): HeldFlight => ({ sourceKey: key, row: 5, route: 'EGLL → EGCC', day: Date.UTC(2026, 10, 21), callsign: 'TST216', pilot: 'Alex', flightId: 5000, reason: 'no-landing-rate', fpm: null });
  const tell = (flights: HeldFlight[], over: Partial<{ send: (id: string, c: string) => Promise<boolean>; managers: () => Promise<string[]> }> = {}) =>
    tellDoubts(
      {
        store: h.store,
        send: over.send ?? (async (id, content) => (sent.push({ to: id, content }), true)),
        managers: over.managers ?? (async () => people),
        now: () => h.clock.now,
        log: silentLogger,
      },
      h.store.getPanel(h.panel.id)!,
      flights,
    );
  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    sent = [];
    people = [MANAGER_1, MANAGER_2];
  });
  afterEach(() => h.close());

  it('sends each manager one message listing the flights', async () => {
    assert.equal(await tell([held('a'), held('b')]), 2);
    assert.deepEqual(sent.map((s) => s.to), [MANAGER_1, MANAGER_2]);
    assert.match(sent[0]!.content, /Safety pay: left unfilled/);
    assert.equal(sent[0]!.content.split('•').length - 1, 2, 'both flights in the one message');
  });

  it('tells them about a flight once, and only about the new ones the next time', async () => {
    await tell([held('a')]);
    sent = [];
    assert.equal(await tell([held('a')]), 0, 'already told');
    assert.equal(await tell([held('a'), held('b')]), 2);
    assert.equal(sent[0]!.content.split('•').length - 1, 1, 'just the new one');
  });

  it('is per panel: the same sheet row of another airline is still news', async () => {
    const other = h.store.createPanel({ guildId: h.panel.guildId, name: 'Other', prefix: 'OTH', channelId: '700000000000000066', now: T0 });
    await tell([held('a')]);
    assert.equal(h.store.hasSafetyDoubt(other.id, 'a'), false);
  });

  it('does not send for nothing held, and does not mind there being nobody to tell', async () => {
    assert.equal(await tell([]), 0);
    people = [];
    assert.equal(await tell([held('c')]), 0);
    assert.equal(h.store.hasSafetyDoubt(h.panel.id, 'c'), true, 'noted, so it is not asked again every run');
  });

  it('carries on past a manager who cannot be reached, and past a lookup that fails', async () => {
    let n = 0;
    assert.equal(await tell([held('d')], { send: async () => ++n === 2 }), 1);
    assert.equal(await tell([held('e')], { managers: async () => { throw new Error('boom'); } }), 0);
    assert.equal(h.store.hasSafetyDoubt(h.panel.id, 'e'), false, 'a failed lookup is not a telling: tried again next time');
  });
});

/* ------------------------------------------------------------------ finding the managers in Discord */

describe('finding an airline\'s managers in Discord', () => {
  const GUILD = '900000000000000001';
  const member = (id: string, roles: string[], bot = false) => ({ id, user: { bot }, roles: { cache: { has: (r: string) => roles.includes(r) } } });
  let pages: Array<Collection<string, ReturnType<typeof member>>>;
  let calls: Array<Record<string, unknown>>;
  let listFails: boolean;
  let ownerId: string | undefined;
  let notifier: Notifier;
  const build = () => {
    const guild = {
      ownerId,
      members: {
        list: async (opts: Record<string, unknown>) => {
          calls.push(opts);
          if (listFails) throw Object.assign(new Error('Missing Access'), { code: 50001 });
          return pages[calls.length - 1] ?? new Collection();
        },
      },
    };
    const client = { guilds: { cache: new Map([[GUILD, guild]]) }, users: { fetch: async (id: string) => ({ id, globalName: id === 'named' ? 'Nora' : null, username: `user-${id}` }) } };
    notifier = new Notifier(client as never, {} as PanelService, silentLogger);
  };
  const col = (...ms: Array<ReturnType<typeof member>>) => new Collection(ms.map((m) => [m.id, m] as [string, ReturnType<typeof member>]));
  beforeEach(() => {
    pages = [col(member('1', [MANAGER_1]), member('2', []), member('3', [MANAGER_2]), member('4', [MANAGER_1], true))];
    calls = [];
    listFails = false;
    ownerId = '555';
    build();
  });

  it('is the members who have one of the roles, leaving out bots and everybody else', async () => {
    assert.deepEqual(await notifier.managerIds(GUILD, [MANAGER_1, MANAGER_2]), ['1', '3']);
  });

  it('reads the member list with Discord\'s REST list, a page at a time, until a short page', async () => {
    const full = col(...Array.from({ length: 1000 }, (_, i) => member(String(100 + i), i === 999 ? [MANAGER_1] : [])));
    pages = [full, col(member('9999', [MANAGER_1]))];
    build();
    assert.deepEqual(await notifier.managerIds(GUILD, [MANAGER_1]), ['1099', '9999']);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.limit, 1000);
    assert.equal(calls[1]!.after, '1099');
  });

  it('tells the server owner instead when no role is set, nobody has it, or the list can\'t be read (the Server Members Intent is off)', async () => {
    assert.deepEqual(await notifier.managerIds(GUILD, []), ['555'], 'no role set');
    assert.equal(calls.length, 0, 'and the members are not read');
    build();
    assert.deepEqual(await notifier.managerIds(GUILD, ['no-such-role']), ['555'], 'nobody has the role');
    listFails = true;
    build();
    assert.deepEqual(await notifier.managerIds(GUILD, [MANAGER_1]), ['555'], 'the list could not be read');
  });

  it('is nobody for a server the bot is not in, or one with no owner it knows', async () => {
    assert.deepEqual(await notifier.managerIds('some-other-server', [MANAGER_1]), []);
    ownerId = undefined;
    listFails = true;
    build();
    assert.deepEqual(await notifier.managerIds(GUILD, [MANAGER_1]), []);
  });

  it('reads the server once for a run of messages to the same managers', async () => {
    await notifier.managerIds(GUILD, [MANAGER_1]);
    await notifier.managerIds(GUILD, [MANAGER_1]);
    assert.equal(calls.length, 1);
    await notifier.managerIds(GUILD, [MANAGER_2]);
    assert.equal(calls.length, 2, 'other roles are another list');
  });

  it('never goes to more than 25 people', async () => {
    pages = [col(...Array.from({ length: 40 }, (_, i) => member(String(1000 + i), [MANAGER_1])))];
    build();
    assert.equal((await notifier.managerIds(GUILD, [MANAGER_1])).length, 25);
  });

  it('looks a pilot\'s name up: the name they show, or their username, or nothing', async () => {
    assert.equal(await notifier.nameOf('named'), 'Nora');
    assert.equal(await notifier.nameOf('plain'), 'user-plain');
    const lost = new Notifier({ guilds: { cache: new Map() }, users: { fetch: async () => { throw new Error('Unknown User'); } } } as never, {} as PanelService, silentLogger);
    assert.equal(await lost.nameOf('gone'), null);
  });
});

/* ------------------------------------------------------------------ from the roles the owner set to the people who are sent a report */

describe('the roles the server owner set, and who is sent the safety reports', () => {
  const OWNER = '555';
  const REFRESHER = '1001'; // holds a /setup refresh-roles role
  const PROFIT_ROLE = '820000000000000003';
  const PROFITER = '1002'; // holds the /setup profit role only
  const BYSTANDER = '1003'; // holds no manager role
  let h: Harness;
  let sent: Array<{ to: string; content: string }>;
  let listFails: boolean;
  let notifier: Notifier;
  let svc: HardLandings;
  const member = (id: string, roles: string[], bot = false) => ({ id, user: { bot }, roles: { cache: { has: (r: string) => roles.includes(r) } } });
  const build = () => {
    const members = new Collection([
      member(REFRESHER, [MANAGER_1]),
      member(PROFITER, [PROFIT_ROLE]),
      member(BYSTANDER, []),
      member('1004', [MANAGER_1], true), // a bot holding the role is left out
      member(OWNER, []),
    ].map((m) => [m.id, m] as [string, ReturnType<typeof member>]));
    const guild = {
      ownerId: OWNER,
      members: {
        list: async () => {
          if (listFails) throw Object.assign(new Error('Missing Access'), { code: 50001 });
          return members;
        },
      },
    };
    notifier = new Notifier({ guilds: { cache: new Map([[SERVER, guild]]) } } as never, {} as PanelService, silentLogger);
    svc = new HardLandings(h.store, async (id, content) => (sent.push({ to: id, content }), true), {
      now: () => h.clock.now,
      managers: managersLookup(h.store, (guildId, roleIds) => notifier.managerIds(guildId, roleIds)),
      nameOf: async () => 'alice',
      csvFile: null,
    });
  };
  const hard = (id: number): FlownFlight => ({
    flightId: id,
    pilotId: 1001,
    pilotName: 'Alice Pilot',
    dep: 'EGLL',
    arr: 'EGKK',
    departedAt: NOW - 2 * HOUR,
    arrivedAt: NOW - 10 * 60_000,
    aircraftIcao: 'A320',
    aircraftName: 'Airbus A320',
    scheduleStatus: 'ON-TIME',
    landingRate: -452,
  });
  const panel = () => h.store.getPanel(h.panel.id)!;
  const reports = () => sent.filter((s) => /Safety violation/.test(s.content)).map((s) => s.to);

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    sent = [];
    listFails = false;
    h.store.setPilotId(USER_A.discordId, 1001, NOW);
    h.store.updatePanel(h.panel.id, { safetyPaySince: NOW - DAY, safetyLossTier2: 0, safetyLossTier3: 0 });
    build();
  });
  afterEach(() => h.close());

  it('sends a Tier 2 or Tier 3 report to the members of the /setup refresh-roles role', async () => {
    h.store.addRefreshRole(SERVER, MANAGER_1, NOW);
    await svc.check(panel(), [hard(7_000_001)]);
    assert.deepEqual(reports(), [REFRESHER], 'the role holder, and not the owner, a bystander or a bot');
  });

  it('sends it to every refresh role, and to the profit role as well', async () => {
    h.store.addRefreshRole(SERVER, MANAGER_1, NOW);
    h.store.updatePanel(h.panel.id, { profitRoleId: PROFIT_ROLE });
    await svc.check(panel(), [hard(7_000_002)]);
    assert.deepEqual(reports().sort(), [REFRESHER, PROFITER].sort());
  });

  it('tells the left-unfilled flights to the same people', async () => {
    h.store.addRefreshRole(SERVER, MANAGER_1, NOW);
    const sentTo: string[] = [];
    const told = await tellDoubts(
      { store: h.store, send: async (id) => (sentTo.push(id), true), managers: managersLookup(h.store, (g, r) => notifier.managerIds(g, r)), now: () => h.clock.now, log: silentLogger },
      panel(),
      [{ sourceKey: 'k', row: 5, route: 'EGLL → EGCC', day: Date.UTC(2026, 10, 21), callsign: 'TST216', pilot: 'Alex', flightId: 5000, reason: 'no-landing-rate', fpm: null }],
    );
    assert.equal(told, 1);
    assert.deepEqual(sentTo, [REFRESHER]);
  });

  it('goes to the server owner when no role is set, and when nobody holds it', async () => {
    await svc.check(panel(), [hard(7_000_003)]);
    assert.deepEqual(reports(), [OWNER], 'no role set');
    sent = [];
    h.store.addRefreshRole(SERVER, '810000000000000099', NOW); // a role nobody has
    build();
    await svc.check(panel(), [hard(7_000_004)]);
    assert.deepEqual(reports(), [OWNER], 'nobody holds the role');
  });

  it("goes to the server owner alone when the member list can't be read, and finds the role holders once it can", async () => {
    h.store.addRefreshRole(SERVER, MANAGER_1, NOW);
    listFails = true;
    build();
    await svc.check(panel(), [hard(7_000_005)]);
    assert.deepEqual(reports(), [OWNER]);
    listFails = false;
    build();
    sent = [];
    await svc.check(panel(), [hard(7_000_006)]);
    assert.deepEqual(reports(), [REFRESHER]);
  });

  it('says whether the roles could be looked up, and keeps a list that could not be read for a minute only', async () => {
    h.store.addRefreshRole(SERVER, MANAGER_1, NOW);
    listFails = true;
    build();
    assert.deepEqual(await notifier.managerCheck(SERVER, [MANAGER_1]), { ids: [OWNER], found: 0, readable: false });
    listFails = false;
    assert.equal((await notifier.managerCheck(SERVER, [MANAGER_1])).readable, false, 'the failed look is kept for a moment');
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61_000;
      assert.deepEqual(await notifier.managerCheck(SERVER, [MANAGER_1]), { ids: [REFRESHER], found: 1, readable: true });
    } finally {
      Date.now = realNow;
    }
  });
});

