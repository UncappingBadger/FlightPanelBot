import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AeroconomyAccountClient } from '../src/aeroconomy/account.js';
import { AeroconomyClient, AEROCONOMY_API, type AeroContract, type AeroFlight } from '../src/aeroconomy/client.js';
import { AeroconomyError } from '../src/aeroconomy/http.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { previewText, profitReport } from '../src/discord/profitUi.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { AirlineProfits, compareProfits, isAirlineCallsign, pairRows, type ProfitAnalysis } from '../src/services/airlineProfits.js';
import { readSheetFlights, type SheetFlight } from '../src/services/contributions.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import type { LogFlight } from '../src/aeroconomy/account.js';
import { HOUR, makeHarness, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeComponent, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';
import { FakeGoogle, flightRow, HEADER, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up: the airline (callsign code TST, FsHub airline 4242, Aeroconomy business 77), its aircraft, pilots and flights. */

const { account, publicKey } = makeServiceAccount();
const AIRLINE = 4242;
const BUSINESS = 77;
const TOKEN = 'fsh-secret-token-0123456789abcdef';
const D12 = Date.UTC(2026, 10, 12);
const D13 = Date.UTC(2026, 10, 13);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A schedule tab with a Profit Made column (column J), as the airline keeps it. */
const GRID_HEADER = [...HEADER, 'Profit Made'];
const row = (route: string, date: string, pilot: string, done: boolean, profit: string, window = '0600-2359z'): string[] => [...flightRow(route, date, pilot, done, 'A320', window), profit];
const profitGrid = (): string[][] => [
  GRID_HEADER,
  ['Week 2', '11/8/2026', 'Week 2'],
  row('EGLL-EGCC', '11/12/2026', 'Alex', true, ''), // row 3: completed, blank
  row('EGCC-EGLL', '11/12/2026', 'Taylor', true, '$50,000.00'), // row 4: completed, filled
  row('KMIA-KORD', '11/12/2026', 'Sam', true, '', '1200-0600z'), // row 5: completed, blank
  row('EGLL-EGPH', '11/12/2026', 'Jo', false, ''), // row 6: not completed
  row('EGLL-EGKK', '11/13/2026', 'Pat', true, ''), // row 7: completed, blank
];
const csvOf = (grid: string[][]) => grid.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

const lf = (over: Partial<LogFlight> = {}): LogFlight => ({
  entryId: 1,
  flightId: 5000,
  callsign: 'TST101',
  dep: 'EGLL',
  arr: 'EGCC',
  pilotId: 7001,
  pilotName: 'Alex',
  profit: 12345.67,
  landedAt: D12 + 10 * HOUR,
  distanceNm: 500,
  ...over,
});

const sheetRow = (over: Partial<SheetFlight> = {}): SheetFlight => ({
  row: 3,
  route: 'EGLL → EGCC',
  sourceKey: 'EGLL-EGCC@2026-11-12',
  flightNumber: null,
  day: D12,
  pilot: 'Alex',
  completed: true,
  profit: null,
  profitRaw: over.profit !== undefined && over.profit !== null ? String(over.profit) : '',
  payRaw: null,
  ...over,
});

/* ------------------------------------------------------------------ talking to Aeroconomy with the token */

describe('reading Aeroconomy\'s aircraft and logbooks with the token', () => {
  let calls: Array<{ url: string; headers: Record<string, string>; method?: string; redirect?: string }>;
  let reply: (url: string) => Response;
  let client: AeroconomyAccountClient;
  const aircraft = (serial: string, extra: Record<string, unknown> = {}) => ({ id: Number(serial), serial, registration: 'G-TEST', airframe: { icao: 'B738' }, owner: { type: 'airline', fshub_airline_id: AIRLINE, business_id: BUSINESS, name: 'Test Air' }, ...extra });
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 10,
    event_type: 'flight',
    airport_icao: 'EGCC',
    pilot: { fshub_user_id: 7001, name: 'Alex' },
    description: 'Flight [EGLL > EGCC]',
    source_flight_id: 5000,
    callsign: 'tst101',
    profit_loss: '12345.67',
    distance_nm: '500.00',
    occurred_at: '2026-11-12T10:00:00.000000Z',
    ...over,
  });
  beforeEach(() => {
    calls = [];
    reply = () => json({}, 404);
    client = new AeroconomyAccountClient(TOKEN, {
      fetchFn: (async (input: unknown, init?: RequestInit) => (calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, method: init?.method, redirect: init?.redirect }), reply(String(input)))) as typeof fetch,
      gapMs: 0,
    });
  });

  it('sends the token only as a bearer header, to Aeroconomy, as a plain GET that never follows a redirect', async () => {
    reply = () => json({ data: [aircraft('00000151')] });
    await client.ownedAircraft(BUSINESS);
    await client.aircraft(151);
    reply = () => json({ data: [] });
    await client.logbook(151);
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.equal(c.method, 'GET');
      assert.equal(c.redirect, 'manual');
      assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
      assert.ok(c.url.startsWith(`${AEROCONOMY_API}/`));
      assert.ok(!c.url.includes(TOKEN), 'never in an address');
    }
    assert.deepEqual(calls.map((c) => c.url.replace(AEROCONOMY_API, '')), [`/businesses/${BUSINESS}/aircraft/owned`, '/aircraft/151', '/aircraft/151/logbook']);
  });

  it('will not be made without a token', () => {
    assert.throws(() => new AeroconomyAccountClient('  '), (e: unknown) => e instanceof AeroconomyError);
  });

  it('reads the airline\'s aircraft, leaving out one it cannot read', async () => {
    reply = () => json({ data: [aircraft('00000151'), { nothing: true }, aircraft('00000287', { owner: false, registration: null })] });
    assert.deepEqual(await client.ownedAircraft(BUSINESS), [
      { serial: 151, registration: 'G-TEST', type: 'B738', ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: BUSINESS },
      { serial: 287, registration: null, type: 'B738', ownerType: null, ownerAirlineId: null, businessId: null },
    ]);
    reply = () => json({}, 404);
    assert.deepEqual(await client.ownedAircraft(BUSINESS), [], 'none for a business that is not there');
    reply = () => json({ data: 'many' });
    await assert.rejects(client.ownedAircraft(BUSINESS), (e: unknown) => e instanceof AeroconomyError);
  });

  it('reads one aircraft, or none', async () => {
    reply = () => json({ data: aircraft('00000151') });
    assert.equal((await client.aircraft(151))!.businessId, BUSINESS);
    reply = () => json({}, 404);
    assert.equal(await client.aircraft(999), null);
  });

  it('reads a logbook\'s flights with their profit, callsign, FsHub flight and pilot, and nothing else in it', async () => {
    reply = () =>
      json({
        data: [
          entry(),
          entry({ id: 11, event_type: 'registration', description: 'Registered G-TEST', profit_loss: null }),
          entry({ id: 12, description: 'Flight [KMIA > KORD]', callsign: null, source_flight_id: null, profit_loss: '-8093.66', pilot: { fshub_user_id: 7002, name: ' Sam ' } }),
          entry({ id: 13, profit_loss: null }),
          entry({ id: 14, description: 'A test flight' }),
          entry({ id: 15, occurred_at: 'not a date' }),
          entry({ id: 16, profit_loss: 500, callsign: '  ', distance_nm: 1325 }),
          entry({ id: 17, event_type: 'ownership_transfer', profit_loss: '999' }),
        ],
      });
    assert.deepEqual(await client.logbook(151), [
      { entryId: 10, flightId: 5000, callsign: 'TST101', dep: 'EGLL', arr: 'EGCC', pilotId: 7001, pilotName: 'Alex', profit: 12345.67, landedAt: Date.parse('2026-11-12T10:00:00Z'), distanceNm: 500 },
      { entryId: 12, flightId: null, callsign: null, dep: 'KMIA', arr: 'KORD', pilotId: 7002, pilotName: 'Sam', profit: -8093.66, landedAt: Date.parse('2026-11-12T10:00:00Z'), distanceNm: 500 },
      { entryId: 16, flightId: 5000, callsign: null, dep: 'EGLL', arr: 'EGCC', pilotId: 7001, pilotName: 'Alex', profit: 500, landedAt: Date.parse('2026-11-12T10:00:00Z'), distanceNm: 1325 },
    ]);
  });

  it('reads the distance a logbook flight logged as a plain number of nautical miles, or as none when it is not one', async () => {
    const distances = ['392.00', 392, ' 12 ', '-5', -5, '', 'far', null, true, 100001, 100000, '1e3', { nm: 5 }];
    reply = () => json({ data: distances.map((d, i) => entry({ id: 100 + i, distance_nm: d })) });
    assert.deepEqual((await client.logbook(151)).map((f) => f.distanceNm), [392, 392, 12, null, null, null, null, null, null, null, 100000, null, null]);
    reply = () => json({ data: [(({ distance_nm: _gone, ...rest }) => rest)(entry())] });
    assert.deepEqual((await client.logbook(151)).map((f) => f.distanceNm), [null], 'a logbook entry with no distance at all');
  });

  it('says what a refusal means, in words, without repeating the token', async () => {
    reply = () => json({ message: '' }, 403);
    await assert.rejects(client.logbook(151), (e: unknown) => e instanceof AeroconomyError && /won't show that to the account/.test(e.message) && !e.message.includes(TOKEN));
    reply = () => json({ message: 'Unauthorised' }, 401);
    await assert.rejects(client.logbook(151), (e: unknown) => e instanceof AeroconomyError && /did not accept the FsHub token/.test(e.message) && !e.message.includes(TOKEN));
  });

  it('does not ask about something that is not an aircraft or a business', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.deepEqual(await client.logbook(bad), []);
      assert.equal(await client.aircraft(bad), null);
      assert.deepEqual(await client.ownedAircraft(bad), []);
    }
    assert.equal(calls.length, 0);
  });
});

describe('finding the airline\'s business from a pilot\'s aircraft (a public page: no token)', () => {
  let calls: Array<{ url: string; headers: Record<string, string> }>;
  let reply: (url: string) => Response;
  let client: AeroconomyClient;
  beforeEach(() => {
    calls = [];
    reply = () => json({}, 404);
    client = new AeroconomyClient({ fetchFn: (async (input: unknown, init?: RequestInit) => (calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> }), reply(String(input)))) as typeof fetch, gapMs: 0 });
  });

  it('gives the airline and business that own the aircraft the pilot has out, and sends no credential', async () => {
    reply = () => json({ data: { fshub_pilot_id: 7001, aircraft: { owner: { type: 'airline', fshub_airline_id: AIRLINE, business_id: BUSINESS, code: 'TST' } } } });
    assert.deepEqual(await client.pilotAircraftOwner(7001), { airlineId: AIRLINE, businessId: BUSINESS });
    assert.equal(calls[0]!.url, `${AEROCONOMY_API}/pilots/7001`);
    assert.deepEqual(Object.keys(calls[0]!.headers).sort(), ['accept', 'user-agent']);
  });

  it('says none when the pilot has no aircraft out, it is not an airline\'s, or there is no such pilot', async () => {
    reply = () => json({ data: { aircraft: null } });
    assert.equal(await client.pilotAircraftOwner(7001), null);
    reply = () => json({ data: { aircraft: { owner: { type: 'business', business_id: 5 } } } });
    assert.equal(await client.pilotAircraftOwner(7001), null);
    reply = () => json({ data: { aircraft: { owner: { type: 'business', fshub_airline_id: AIRLINE, business_id: 5 } } } });
    assert.equal(await client.pilotAircraftOwner(7001), null, 'only an airline aircraft counts');
    reply = () => json({}, 404);
    assert.equal(await client.pilotAircraftOwner(7001), null);
    assert.equal(await client.pilotAircraftOwner(0), null);
    assert.equal(calls.length, 4, 'nothing asked for a pilot that is not one');
  });
});

/* ------------------------------------------------------------------ pairing and comparing */

describe('pairing the sheet\'s completed flights with the logbook\'s', () => {
  it('only counts a flight flown under the airline\'s own callsign', () => {
    assert.equal(isAirlineCallsign('TST101', 'TST'), true);
    for (const bad of [null, '', 'UAL12', 'TST', 'TSTAIR', 'XTST1']) assert.equal(isAirlineCallsign(bad, 'TST'), false, String(bad));
    assert.equal(isAirlineCallsign('TST1', ''), false);
  });

  it('pairs a row with the flight between the same two airports that landed in its day, a little early or up to a day and a half after it began', () => {
    const rows = [sheetRow()];
    assert.equal(pairRows(rows, [lf()]).pairs.length, 1);
    assert.equal(pairRows(rows, [lf({ landedAt: D12 - 5 * HOUR })]).pairs.length, 1, 'landed early');
    assert.equal(pairRows(rows, [lf({ landedAt: D12 + 35 * HOUR })]).pairs.length, 1, 'landed after midnight of the next day');
    assert.equal(pairRows(rows, [lf({ landedAt: D12 - 7 * HOUR })]).unmatched.length, 1, 'too early');
    assert.equal(pairRows(rows, [lf({ landedAt: D12 + 37 * HOUR })]).unmatched.length, 1, 'too late');
    assert.equal(pairRows(rows, [lf({ dep: 'EGCC', arr: 'EGLL' })]).unmatched.length, 1, 'the other way round');
    assert.equal(pairRows(rows, [lf({ arr: 'EGKK' })]).unmatched.length, 1, 'another route');
  });

  it('cannot pair a flight of several legs', () => {
    assert.equal(pairRows([sheetRow({ route: 'EGLL → EGCC, EGCC → EGPH' })], [lf()]).unmatched.length, 1);
  });

  it('settles several flights that could be it by the pilot\'s name, and does not guess otherwise', () => {
    const flights = [lf({ entryId: 1, pilotName: 'Alex' }), lf({ entryId: 2, pilotName: 'Sam', flightId: 5001 })];
    const byName = pairRows([sheetRow({ pilot: ' sam ' })], flights);
    assert.equal(byName.pairs[0]!.flight.entryId, 2);
    const strangers = pairRows([sheetRow({ pilot: 'Pat' })], flights);
    assert.deepEqual({ pairs: strangers.pairs.length, ambiguous: strangers.ambiguous.length }, { pairs: 0, ambiguous: 1 });
    const same = pairRows([sheetRow()], [lf({ entryId: 1 }), lf({ entryId: 2, flightId: 5001 })]);
    assert.equal(same.ambiguous.length, 1, 'two flights with the same pilot are not told apart');
  });

  it('never lets one flight belong to two rows', () => {
    const rows = [sheetRow({ row: 3 }), sheetRow({ row: 9, sourceKey: 'EGLL-EGCC@2026-11-12#2' })];
    const got = pairRows(rows, [lf()]);
    assert.deepEqual({ pairs: got.pairs.length, ambiguous: got.ambiguous.length }, { pairs: 0, ambiguous: 2 });
  });
});

describe('comparing profits', () => {
  const only = (rows: SheetFlight[], flights: LogFlight[]) => compareProfits(rows, flights, 'TST');

  it('calls two profits the same when they are within a dollar (the sheet is kept in whole dollars), and different otherwise', () => {
    const rows = [
      sheetRow({ row: 3, profit: 12346 }), // 12345.67 rounds to it
      sheetRow({ row: 4, sourceKey: 'a@b', pilot: 'B', route: 'EGCC → EGLL', profit: 12344.7 }),
      sheetRow({ row: 5, sourceKey: 'c@d', pilot: 'C', route: 'KMIA → KORD', profit: 10000 }),
      sheetRow({ row: 6, sourceKey: 'e@f', pilot: 'D', route: 'EGKK → EGLL', profit: 12340 }), // five dollars out
    ];
    const flights = [lf(), lf({ entryId: 2, dep: 'EGCC', arr: 'EGLL', pilotName: 'B', profit: 12345.67, flightId: 1 }), lf({ entryId: 3, dep: 'KMIA', arr: 'KORD', pilotName: 'C', profit: 12345.67, flightId: 2 }), lf({ entryId: 4, dep: 'EGKK', arr: 'EGLL', pilotName: 'D', profit: 12345.67, flightId: 3 })];
    const r = only(rows, flights);
    assert.deepEqual({ matched: r.matched, agree: r.agree, different: r.different.map((d) => d.row), fills: r.fills.length }, { matched: 4, agree: 2, different: [5, 6], fills: 0 });
    assert.deepEqual(r.different[0], { row: 5, route: 'KMIA → KORD', day: D12, callsign: 'TST101', sheet: 10000, aeroconomy: 12345.67 });
  });

  it('offers a blank cell the profit in whole dollars, a loss included, and never a zero with a minus sign', () => {
    const rows = [sheetRow({ row: 3 }), sheetRow({ row: 4, sourceKey: 'x@y', pilot: 'B', route: 'EGCC → EGLL' }), sheetRow({ row: 5, sourceKey: 'z@w', pilot: 'C', route: 'KMIA → KORD' })];
    const flights = [lf({ profit: 12345.67 }), lf({ entryId: 2, dep: 'EGCC', arr: 'EGLL', pilotName: 'B', profit: -8093.66, flightId: 1 }), lf({ entryId: 3, dep: 'KMIA', arr: 'KORD', pilotName: 'C', profit: -0.3, flightId: 2 })];
    const r = only(rows, flights);
    assert.deepEqual(r.fills.map((f) => [f.row, f.value, f.exact]), [[3, 12346, 12345.67], [4, -8094, -8093.66], [5, 0, -0.3]]);
    assert.ok(Object.is(r.fills[2]!.value, 0), 'plain zero');
    assert.deepEqual(r.fills[0], {
      sourceKey: 'EGLL-EGCC@2026-11-12',
      value: 12346,
      pay: null,
      row: 3,
      pilot: 'Alex',
      route: 'EGLL → EGCC',
      day: D12,
      callsign: 'TST101',
      exact: 12345.67,
      flightId: 5000,
      logbookNm: 500,
      payPlan: { amount: 2000, basis: 'minimum', distanceNm: null, problem: null, cell: 'missing' },
    });
  });

  it('leaves out rows that are not ticked as completed, and flights that were not flown under the airline\'s own callsign', () => {
    const r = only([sheetRow({ completed: false })], [lf()]);
    assert.deepEqual({ completed: r.sheetCompleted, matched: r.matched }, { completed: 0, matched: 0 });
    const r2 = only([sheetRow()], [lf({ callsign: 'UAL12' }), lf({ entryId: 2, callsign: null, flightId: 9 })]);
    assert.deepEqual({ read: r2.logbookFlights, usable: r2.usableFlights, matched: r2.matched, unmatched: r2.unmatched }, { read: 2, usable: 0, matched: 0, unmatched: 1 });
  });

  it('only ever offers a cell that has nothing in it: a note, a stray space or anything else already there is left alone', () => {
    const rows = [
      sheetRow({ row: 3, profit: null, profitRaw: '' }),
      sheetRow({ row: 4, sourceKey: 'a@b', pilot: 'B', route: 'EGCC → EGLL', profit: null, profitRaw: 'TBD' }),
      sheetRow({ row: 5, sourceKey: 'c@d', pilot: 'C', route: 'KMIA → KORD', profit: null, profitRaw: ' ' }),
      sheetRow({ row: 6, sourceKey: 'e@f', pilot: 'D', route: 'EGKK → EGLL', profit: null, profitRaw: '#N/A' }),
      sheetRow({ row: 7, sourceKey: 'g@h', pilot: 'E', route: 'EGKK → EGCC', profit: null, profitRaw: null }),
    ];
    const flights = [lf(), lf({ entryId: 2, dep: 'EGCC', arr: 'EGLL', pilotName: 'B', flightId: 1 }), lf({ entryId: 3, dep: 'KMIA', arr: 'KORD', pilotName: 'C', flightId: 2 }), lf({ entryId: 4, dep: 'EGKK', arr: 'EGLL', pilotName: 'D', flightId: 3 }), lf({ entryId: 5, dep: 'EGKK', arr: 'EGCC', pilotName: 'E', flightId: 4 })];
    const r = only(rows, flights);
    assert.deepEqual({ fills: r.fills.map((f) => f.row), unreadable: r.unreadable, matched: r.matched }, { fills: [3], unreadable: 4, matched: 5 });
  });

  it('reads what is in the Profit Made cell exactly as it is, so a space does not look empty', () => {
    const grid = profitGrid();
    grid[2]![9] = ' ';
    grid[3]![9] = '$50,000.00';
    grid[4]![9] = 'TBD';
    const read = readSheetFlights(csvOf(grid))!;
    const byRow = new Map(read.flights.map((f) => [f.row, f]));
    assert.deepEqual([byRow.get(3)!.profitRaw, byRow.get(4)!.profitRaw, byRow.get(5)!.profitRaw, byRow.get(7)!.profitRaw], [' ', '$50,000.00', 'TBD', '']);
    assert.deepEqual([byRow.get(3)!.profit, byRow.get(4)!.profit, byRow.get(5)!.profit], [null, 50000, null]);
    const noColumn = readSheetFlights(csvOf(profitGrid().map((r) => r.slice(0, 9))))!;
    assert.ok(noColumn.flights.every((f) => f.profitRaw === null));
  });

  it('puts what it found in order of row', () => {
    const rows = [sheetRow({ row: 9, sourceKey: 'p@q', pilot: 'P', route: 'EGKK → EGLL' }), sheetRow({ row: 3 })];
    const flights = [lf(), lf({ entryId: 2, dep: 'EGKK', arr: 'EGLL', pilotName: 'P', flightId: 1 })];
    assert.deepEqual(only(rows, flights).fills.map((f) => f.row), [3, 9]);
  });
});

/* ------------------------------------------------------------------ reading both sides */

describe('checking an airline\'s profits against its sheet', () => {
  let h: Harness;
  let sheetCsv: string;
  let sheetCalls: number;
  let fleetCalls: number[];
  let logbooks: Map<number, LogFlight[]>;
  let owners: Map<number, { airlineId: number; businessId: number } | null>;
  let pilotCalls: number[];
  let fleetOwner: { type: string | null; airlineId: number | null };
  /** What the airline's contracts and their flights say, and what was asked of Aeroconomy to find the business that way. */
  let contracts: AeroContract[];
  let contractFlights: Map<number, AeroFlight[]>;
  let contractCalls: number;
  let manifestCalls: number[];
  let aircraftAsked: number[];
  let aircraftOwners: Map<number, { type: string | null; airlineId: number | null; businessId?: number | null }>;
  let contractsFail: boolean;
  let profits: AirlineProfits;
  const pid = () => h.panel.id;
  const panel = () => h.store.getPanel(pid())!;

  const build = () => {
    profits = new AirlineProfits({
      store: h.store,
      account: {
        async ownedAircraft(business: number) {
          fleetCalls.push(business);
          return [151, 287].map((serial) => ({ serial, registration: null, type: 'B738', ownerType: fleetOwner.type, ownerAirlineId: fleetOwner.airlineId, businessId: business }));
        },
        async aircraft(serial: number) {
          aircraftAsked.push(serial);
          const owner: { type: string | null; airlineId: number | null; businessId?: number | null } = aircraftOwners.get(serial) ?? fleetOwner;
          return { serial, registration: null, type: 'B738', ownerType: owner.type, ownerAirlineId: owner.airlineId, businessId: owner.businessId === undefined ? BUSINESS : owner.businessId };
        },
        async logbook(serial: number) {
          return logbooks.get(serial) ?? [];
        },
      },
      publicClient: {
        async pilotAircraftOwner(id: number) {
          pilotCalls.push(id);
          return owners.get(id) ?? null;
        },
        async airlineContracts() {
          contractCalls++;
          if (contractsFail) throw new AeroconomyError('Aeroconomy asked the bot to slow down.');
          return contracts;
        },
        async manifests(id: number) {
          manifestCalls.push(id);
          return contractFlights.get(id) ?? [];
        },
      },
      fetchFn: (async () => (sheetCalls++, new Response(sheetCsv, { status: 200, headers: { 'content-type': 'text/csv' } }))) as typeof fetch,
      now: () => h.clock.now,
    });
  };

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    sheetCsv = csvOf(profitGrid());
    sheetCalls = 0;
    fleetCalls = [];
    pilotCalls = [];
    fleetOwner = { type: 'airline', airlineId: AIRLINE };
    contracts = [];
    contractFlights = new Map();
    contractCalls = 0;
    manifestCalls = [];
    aircraftAsked = [];
    aircraftOwners = new Map();
    contractsFail = false;
    owners = new Map([
      [7001, null],
      [7002, { airlineId: 9999, businessId: 11 }],
      [7003, { airlineId: AIRLINE, businessId: BUSINESS }],
    ]);
    logbooks = new Map([
      [151, [lf({ profit: 12345.67 }), lf({ entryId: 2, dep: 'KMIA', arr: 'KORD', pilotName: 'Sam', callsign: 'TST202', profit: -4000.4, flightId: 5001, landedAt: D12 + 20 * HOUR })]],
      [287, [lf({ entryId: 3, dep: 'EGCC', arr: 'EGLL', pilotName: 'Taylor', callsign: 'TST303', profit: 49000, flightId: 5002 }), lf({ entryId: 4, callsign: 'UAL9', flightId: 5003, dep: 'EGLL', arr: 'EGKK', pilotName: 'Pat', landedAt: D13 + 10 * HOUR })]],
    ]);
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE });
    h.store.setPilotId(USER_A.discordId, 7001, T0);
    build();
  });
  afterEach(async () => {
    await h.close();
  });

  it('reads the logbooks and the sheet and says what agrees, what is blank, and what differs', async () => {
    h.store.upsertFshubFlights(pid(), [{ flightId: 1, pilotId: 7003, pilotName: 'Three', dep: 'EGLL', arr: 'EGCC', departedAt: T0 - HOUR, arrivedAt: T0, aircraftIcao: 'A320', aircraftName: null, scheduleStatus: null }]);
    const a = await profits.analyse(panel());
    assert.deepEqual(
      { business: a.business, aircraft: a.aircraft, read: a.logbookFlights, usable: a.usableFlights, completed: a.sheetCompleted, matched: a.matched, agree: a.agree, different: a.different.length, blank: a.fills.map((f) => [f.row, f.value]), unmatched: a.unmatched, ambiguous: a.ambiguous },
      { business: BUSINESS, aircraft: 2, read: 4, usable: 3, completed: 4, matched: 3, agree: 0, different: 1, blank: [[3, 12346], [5, -4000]], unmatched: 1, ambiguous: 0 },
    );
    assert.deepEqual(a.different[0], { row: 4, route: 'EGCC → EGLL', day: D12, callsign: 'TST303', sheet: 50000, aeroconomy: 49000 });
    assert.equal(a.readAt, T0);
    assert.equal(sheetCalls, 1);
  });

  it('finds the airline\'s business from its recent pilots\' aircraft, asking about the next pilot until one is an airline pilot, and remembers it', async () => {
    h.store.upsertFshubFlights(pid(), [7001, 7002, 7003].map((pilotId, i) => ({ flightId: i + 1, pilotId, pilotName: null, dep: 'EGLL', arr: 'EGCC', departedAt: null, arrivedAt: T0 - i * HOUR - 5 * HOUR, aircraftIcao: null, aircraftName: null, scheduleStatus: null })));
    const first = await profits.analyse(panel());
    assert.equal(first.business, BUSINESS);
    assert.deepEqual(pilotCalls, [7001, 7002, 7003], 'newest first, past the one with no aircraft and the one who flies for another airline');
    assert.equal(h.store.getKv(`aero.business.${AIRLINE}`), String(BUSINESS));
    pilotCalls.length = 0;
    await profits.analyse(panel());
    assert.deepEqual(pilotCalls, [], 'not asked again');
  });

  it('says what to do when it cannot find the airline\'s aircraft, and reads nothing of anyone else\'s', async () => {
    owners.clear();
    await assert.rejects(profits.analyse(panel()), (e: unknown) => /couldn't find the airline's aircraft on Aeroconomy/.test((e as Error).message) && /business:/.test((e as Error).message));
    assert.deepEqual(fleetCalls, []);
  });

  it('tells an admin where the business number is and that it is remembered, when nothing shows it', async () => {
    owners.clear();
    await assert.rejects(profits.analyse(panel()), (e: unknown) => /aeroconomy\.com\/businesses\//.test((e as Error).message) && /remember/.test((e as Error).message) && /contract flights or recent pilots/.test((e as Error).message));
  });

  describe('finding the business from the aircraft on the airline\'s own flights', () => {
    const flight = (number: string, status: string, serial?: number): AeroFlight => ({ number, dep: 'EGLL', arr: 'EGKK', start: T0, end: T0 + HOUR, status, ...(serial !== undefined ? { aircraftSerial: serial } : {}) });

    it('asks who owns the aircraft on a flight that has been taken, before asking any pilot, and remembers the business', async () => {
      contracts = [{ id: 10, status: 'awarded', total: 40 }, { id: 11, status: 'active', total: 20 }];
      contractFlights.set(11, [flight('TST1', 'completed'), flight('TST2', 'assigned', 151)]);
      const a = await profits.analyse(panel());
      assert.equal(a.business, BUSINESS);
      assert.deepEqual(aircraftAsked, [151]);
      assert.deepEqual(manifestCalls, [11], 'the contract with flights under way first, and no more once one aircraft showed it');
      assert.deepEqual(pilotCalls, []);
      assert.equal(h.store.getKv(`aero.business.${AIRLINE}`), String(BUSINESS));
      contractCalls = 0;
      manifestCalls.length = 0;
      await profits.analyse(panel());
      assert.equal(contractCalls, 0, 'not looked for again');
      assert.deepEqual(manifestCalls, []);
    });

    it('reads the newer contract first when two are alike', async () => {
      contracts = [{ id: 10, status: 'active', total: 30 }, { id: 11, status: 'active', total: 30 }, { id: 9, status: 'active', total: 30 }];
      owners.clear();
      await assert.rejects(profits.analyse(panel()), /couldn't find/);
      assert.deepEqual(manifestCalls, [11, 10, 9]);
    });

    it('reads the contracts with flights under way first, then the bigger ones, and no more than a dozen of them', async () => {
      contracts = Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, status: i < 3 ? 'awarded' : 'active', total: i }));
      owners.clear();
      await assert.rejects(profits.analyse(panel()), /couldn't find/);
      assert.equal(manifestCalls.length, 12);
      assert.equal(manifestCalls[0], 119, 'active, and the biggest');
      assert.ok(manifestCalls.every((id) => id >= 108), 'the three awarded ones and the smallest active ones are not reached');
    });

    it('goes past an aircraft that is not the airline\'s, and past a contract with none, to one that is', async () => {
      contracts = [{ id: 10, status: 'active', total: 30 }, { id: 11, status: 'active', total: 20 }, { id: 12, status: 'active', total: 10 }];
      contractFlights.set(10, [flight('TST1', 'planned')]);
      contractFlights.set(11, [flight('TST2', 'assigned', 901), flight('TST3', 'assigned', 902)]);
      contractFlights.set(12, [flight('TST4', 'assigned', 151)]);
      aircraftOwners.set(901, { type: 'business', airlineId: null });
      aircraftOwners.set(902, { type: 'airline', airlineId: 9999 });
      assert.equal((await profits.analyse(panel())).business, BUSINESS);
      assert.deepEqual(aircraftAsked, [901, 902, 151]);
      assert.deepEqual(manifestCalls, [10, 11, 12]);
    });

    it('only takes the business of an aircraft that belongs to the airline itself and names its business', async () => {
      contracts = [{ id: 10, status: 'active', total: 30 }];
      contractFlights.set(10, [flight('A', 'assigned', 901), flight('B', 'assigned', 902), flight('C', 'assigned', 151)]);
      aircraftOwners.set(901, { type: 'business', airlineId: AIRLINE }); // a business's aircraft that merely carries the airline's number
      aircraftOwners.set(902, { type: 'airline', airlineId: AIRLINE, businessId: null }); // the airline's, but no business to read the fleet from
      assert.equal((await profits.analyse(panel())).business, BUSINESS);
      assert.deepEqual(aircraftAsked, [901, 902, 151]);
    });

    it('asks about an aircraft only once, however many flights carry it, and about no more than four', async () => {
      contracts = [{ id: 10, status: 'active', total: 30 }];
      contractFlights.set(10, [flight('A', 'assigned', 901), flight('B', 'assigned', 901), ...[902, 903, 904, 905, 906].map((s) => flight(`S${s}`, 'assigned', s))]);
      for (const s of [901, 902, 903, 904, 905, 906]) aircraftOwners.set(s, { type: 'business', airlineId: null });
      owners.clear();
      await assert.rejects(profits.analyse(panel()), /couldn't find/);
      assert.deepEqual(aircraftAsked, [901, 902, 903, 904]);
    });

    it('goes on to the pilots when no flight has an aircraft, and the pilots still work as before', async () => {
      contracts = [{ id: 10, status: 'active', total: 30 }];
      contractFlights.set(10, [flight('TST1', 'planned'), flight('TST2', 'completed')]);
      h.store.upsertFshubFlights(pid(), [7001, 7002, 7003].map((pilotId, i) => ({ flightId: i + 1, pilotId, pilotName: null, dep: 'EGLL', arr: 'EGCC', departedAt: null, arrivedAt: T0 - i * HOUR - 5 * HOUR, aircraftIcao: null, aircraftName: null, scheduleStatus: null })));
      assert.equal((await profits.analyse(panel())).business, BUSINESS);
      assert.deepEqual(aircraftAsked, []);
      assert.deepEqual(pilotCalls, [7001, 7002, 7003]);
    });

    it('is not stopped by Aeroconomy refusing to list the contracts, or to show one aircraft: it goes on to the next way', async () => {
      contractsFail = true;
      h.store.upsertFshubFlights(pid(), [{ flightId: 1, pilotId: 7003, pilotName: null, dep: 'EGLL', arr: 'EGCC', departedAt: null, arrivedAt: T0 - 5 * HOUR, aircraftIcao: null, aircraftName: null, scheduleStatus: null }]);
      assert.equal((await profits.analyse(panel())).business, BUSINESS, 'found from the pilot');
      h.store.setKv(`aero.business.${AIRLINE}`, '');
      contractsFail = false;
      contracts = [{ id: 10, status: 'active', total: 30 }];
      contractFlights.set(10, [flight('TST1', 'assigned', 901), flight('TST2', 'assigned', 151)]);
      const brokenAircraft = new AirlineProfits({
        store: h.store,
        account: {
          async ownedAircraft(b: number) { return [{ serial: 151, registration: null, type: 'B738', ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: b }]; },
          async aircraft(serial: number) { if (serial === 901) throw new AeroconomyError("Aeroconomy won't show that."); return { serial, registration: null, type: 'B738', ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: BUSINESS }; },
          async logbook() { return []; },
        },
        publicClient: { async pilotAircraftOwner() { return null; }, async airlineContracts() { return contracts; }, async manifests(id: number) { return contractFlights.get(id) ?? []; } },
        fetchFn: (async () => new Response(sheetCsv, { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch,
        now: () => h.clock.now,
      });
      assert.equal((await brokenAircraft.analyse(panel())).business, BUSINESS, 'the second aircraft showed it');
    });

    it('does not look at the flights at all when the number is given or already remembered', async () => {
      contracts = [{ id: 10, status: 'active', total: 30 }];
      contractFlights.set(10, [flight('TST1', 'assigned', 151)]);
      await profits.analyse(panel(), 88);
      assert.equal(contractCalls, 0);
      await profits.analyse(panel());
      assert.equal(contractCalls, 0, 'remembered from the number that was given');
    });
  });

  it('uses a business number an admin gave when it is the airline\'s, and remembers it', async () => {
    const a = await profits.analyse(panel(), 88);
    assert.equal(a.business, 88);
    assert.deepEqual(pilotCalls, []);
    assert.equal(h.store.getKv(`aero.business.${AIRLINE}`), '88');
  });

  it('refuses a business number that is another airline\'s, before reading any logbook, and does not remember it', async () => {
    fleetOwner = { type: 'airline', airlineId: 9999 };
    let logbookReads = 0;
    const original = logbooks.get.bind(logbooks);
    logbooks.get = (k: number) => (logbookReads++, original(k));
    await assert.rejects(profits.analyse(panel(), 88), (e: unknown) => /isn't this airline's/.test((e as Error).message));
    assert.equal(logbookReads, 0);
    assert.equal(h.store.getKv(`aero.business.${AIRLINE}`), null);
    fleetOwner = { type: 'business', airlineId: null };
    await assert.rejects(profits.analyse(panel(), 88), (e: unknown) => /isn't this airline's/.test((e as Error).message));
  });

  it('says plainly what is missing: a sheet, the FsHub link, a Profit Made column, aircraft, or a schedule', async () => {
    h.store.updatePanel(pid(), { sheetId: null, sheetGid: null });
    await assert.rejects(profits.analyse(panel(), BUSINESS), /doesn't read a Google Sheet/);
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: null });
    await assert.rejects(profits.analyse(panel(), BUSINESS), /isn't linked to its airline's FsHub roster/);
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE });
    sheetCsv = csvOf(profitGrid().map((r) => r.slice(0, 9)));
    await assert.rejects(profits.analyse(panel(), BUSINESS), /no Profit Made column/);
    sheetCsv = 'Name,Score\nAnna,5';
    await assert.rejects(profits.analyse(panel(), BUSINESS), /couldn't read that sheet as a schedule/);
    sheetCsv = csvOf(profitGrid());
    fleetOwner = { type: 'airline', airlineId: AIRLINE };
    const noAircraft = new AirlineProfits({ store: h.store, account: { ownedAircraft: async () => [], aircraft: async () => null, logbook: async () => [] }, publicClient: { pilotAircraftOwner: async () => null }, now: () => T0 });
    await assert.rejects(noAircraft.analyse(panel(), BUSINESS), /lists no aircraft/);
  });
});

/* ------------------------------------------------------------------ writing into the sheet */

describe('filling blank Profit Made cells in the sheet', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const fill = (row: number, value: number, pilot: string, key: string) => ({ sourceKey: key, value, row, pilot });
  const K = { open: 'EGLL-EGCC@2026-11-12', filled: 'EGCC-EGLL@2026-11-12', overnight: 'KMIA-KORD@2026-11-12', notDone: 'EGLL-EGPH@2026-11-12', next: 'EGLL-EGKK@2026-11-13' };

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = profitGrid();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes the profits into the blank Profit Made cells of ticked rows, as numbers, in one request, and touches nothing else', async () => {
    const before = g.values.map((r) => [...r]);
    const got = await wb.fillProfits(panel(), [fill(3, 12346, 'Alex', K.open), fill(5, -4000, 'Sam', K.overnight), fill(7, 0, 'Pat', K.next)]);
    assert.deepEqual(got.written.map((w) => [w.cell, w.value]), [['J3', 12346], ['J5', -4000], ['J7', 0]]);
    assert.deepEqual(got.skipped, []);
    assert.equal(g.writes.length, 1);
    assert.equal(g.writes[0]!.valueInputOption, 'RAW');
    assert.deepEqual(g.writes[0]!.data.map((d) => d.values[0]![0]), [12346, -4000, 0]);
    assert.ok(g.writes[0]!.data.every((d) => typeof d.values[0]![0] === 'number'), 'numbers, not text');
    for (let r = 0; r < before.length; r++) for (let c = 0; c < before[r]!.length; c++) if (!['J3', 'J5', 'J7'].includes(`J${r + 1}`) || c !== 9) assert.equal(g.values[r]![c] ?? '', before[r]![c] ?? '', `row ${r + 1} column ${c}`);
  });

  it('never replaces what is already in a cell', async () => {
    const got = await wb.fillProfits(panel(), [fill(4, 99999, 'Taylor', K.filled)]);
    assert.deepEqual(got.skipped, [{ sourceKey: K.filled, reason: 'filled' }]);
    assert.equal(g.writes.length, 0, 'not even a request');
    assert.equal(g.cell('J4'), '$50,000.00');
    g.values[2]![9] = '0';
    assert.deepEqual((await wb.fillProfits(panel(), [fill(3, 5, 'Alex', K.open)])).skipped, [{ sourceKey: K.open, reason: 'filled' }], 'a zero is something');
    assert.equal(g.writes.length, 0);
  });

  it('counts anything at all in a cell as filled: a note, a stray space, or a formula that shows nothing', async () => {
    const attempt = async (setup: () => void) => {
      g.values = profitGrid();
      g.formulas.clear();
      setup();
      return wb.fillProfits(panel(), [fill(3, 12346, 'Alex', K.open)]);
    };
    for (const [what, setup] of [
      ['a note', () => void (g.values[2]![9] = 'TBD')],
      ['a stray space', () => void (g.values[2]![9] = ' ')],
      ['an error', () => void (g.values[2]![9] = '#N/A')],
      ['a formula that shows nothing', () => void g.formulas.set('J3', '=IF(1=2,1,"")')],
      ['a formula with a value', () => void ((g.values[2]![9] = '$5.00'), g.formulas.set('J3', '=D3*2'))],
    ] as Array<[string, () => void]>) {
      const got = await attempt(setup);
      assert.deepEqual(got.skipped, [{ sourceKey: K.open, reason: 'filled' }], what);
      assert.deepEqual(got.written, [], what);
    }
    assert.equal(g.writes.length, 0, 'nothing was written over any of them');
    const clean = await attempt(() => undefined);
    assert.deepEqual(clean.written.map((w) => w.cell), ['J3'], 'a truly empty cell still is filled');
  });

  it('leaves a row alone that has moved, whose pilot changed, that is not ticked, or that is gone, and says why', async () => {
    g.values.splice(2, 0, row('EGLL-EGPH', '11/14/2026', '', false, '')); // a row inserted above: every row below moves down
    const moved = await wb.fillProfits(panel(), [fill(3, 1, 'Alex', K.open)]);
    assert.deepEqual(moved.skipped, [{ sourceKey: K.open, reason: 'moved' }]);
    g.values = profitGrid();
    g.values[4]![4] = 'Somebody Else';
    assert.deepEqual((await wb.fillProfits(panel(), [fill(5, 1, 'Sam', K.overnight)])).skipped, [{ sourceKey: K.overnight, reason: 'changed' }]);
    assert.deepEqual((await wb.fillProfits(panel(), [fill(6, 1, 'Jo', K.notDone)])).skipped, [{ sourceKey: K.notDone, reason: 'not-completed' }]);
    g.values[2]![7] = 'FALSE';
    assert.deepEqual((await wb.fillProfits(panel(), [fill(3, 1, 'Alex', K.open)])).skipped, [{ sourceKey: K.open, reason: 'not-completed' }], 'unticked since');
    g.values = profitGrid();
    g.values.splice(2, 1);
    assert.deepEqual((await wb.fillProfits(panel(), [fill(3, 1, 'Alex', K.open)])).skipped, [{ sourceKey: K.open, reason: 'gone' }]);
    assert.equal(g.writes.length, 0);
  });

  it('does not write to a row the pilot of which is cancelled', async () => {
    g.values[2]![4] = 'CANCELLED';
    assert.deepEqual((await wb.fillProfits(panel(), [fill(3, 1, 'CANCELLED', K.open)])).skipped, [{ sourceKey: K.open, reason: 'not-completed' }]);
  });

  it('writes only what is still blank when it looks, so a manager who typed one meanwhile is not overwritten', async () => {
    g.beforeNextRead = () => {
      g.values[2]![9] = '$13,000.00';
    };
    const got = await wb.fillProfits(panel(), [fill(3, 12346, 'Alex', K.open), fill(5, -4000, 'Sam', K.overnight)]);
    assert.deepEqual(got.written.map((w) => w.cell), ['J5']);
    assert.deepEqual(got.skipped, [{ sourceKey: K.open, reason: 'filled' }]);
    assert.equal(g.cell('J3'), '$13,000.00');
  });

  it('writes nothing, and asks nothing of Google, when there is nothing to write', async () => {
    const got = await wb.fillProfits(panel(), []);
    assert.deepEqual(got, { written: [], paid: [], payLeft: 0, skipped: [] });
    assert.equal(g.writes.length, 0);
  });

  it('says so when the tab has no Profit Made column or is not a schedule, or Google refuses', async () => {
    g.values = profitGrid().map((r) => r.slice(0, 9));
    await assert.rejects(wb.fillProfits(panel(), [fill(3, 1, 'Alex', K.open)]), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_COLUMNS' && /Profit Made column/.test(e.message));
    g.values = [['Name', 'Score'], ['Anna', '5']];
    await assert.rejects(wb.fillProfits(panel(), [fill(3, 1, 'Alex', K.open)]), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_COLUMNS');
    g.values = profitGrid();
    g.mode = 'view-only';
    await assert.rejects(wb.fillProfits(panel(), [fill(3, 12346, 'Alex', K.open)]), (e: unknown) => e instanceof WriteBackError && e.code === 'GOOGLE');
    h.store.updatePanel(h.panel.id, { sheetId: null, sheetGid: null });
    await assert.rejects(wb.fillProfits(panel(), [fill(3, 1, 'Alex', K.open)]), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_SHEET');
  });
});

/* ------------------------------------------------------------------ the command */

describe('/setup profit', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
  const profitButtons = componentHandlers.find((c) => c.prefix === 'profit')!;
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let profits: AirlineProfits;
  let logbooks: LogFlight[];
  let accountReads: string[];
  let admin: FakeUser;
  const pid = () => h.panel.id;

  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'profit', admin: true, userId: USER_A.discordId, ...o });
    let error: Error | null = null;
    try {
      await setup.execute(d.ctx, f.i);
    } catch (e) {
      error = e as Error;
    }
    await settle(40);
    const last = f.calls.edits.at(-1);
    return { text: String(last?.content ?? ''), components: (last?.components ?? []) as any[], error };
  };
  const press = async (customId: string, o: { user?: FakeUser; admin?: boolean } = {}) => {
    const f = fakeComponent(o.user ?? admin, customId, { admin: o.admin ?? true });
    await profitButtons.handle(d.ctx, f.i);
    await settle(40);
    return { updates: f.calls.updates, edits: f.calls.edits, replies: f.calls.replies, text: String((f.calls.edits.at(-1) ?? f.calls.updates.at(-1))?.content ?? f.calls.replies.at(-1)?.content ?? '') };
  };
  const idsOf = (components: any[]): string[] => components.flatMap((r: any) => (r.toJSON?.().components ?? r.components ?? []).map((c: any) => c.custom_id ?? c.customId));

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = profitGrid();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: wb });
    admin = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    accountReads = [];
    logbooks = [lf(), lf({ entryId: 2, dep: 'KMIA', arr: 'KORD', pilotName: 'Sam', callsign: 'TST202', profit: -4000.4, flightId: 5001, landedAt: D12 + 20 * HOUR }), lf({ entryId: 3, dep: 'EGCC', arr: 'EGLL', pilotName: 'Taylor', callsign: 'TST303', profit: 49000, flightId: 5002 })];
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE, writeback: true });
    profits = new AirlineProfits({
      store: h.store,
      account: {
        async ownedAircraft(b: number) {
          accountReads.push(`fleet:${b}`);
          return [{ serial: 151, registration: null, type: 'B738', ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: b }];
        },
        async aircraft(serial: number) {
          accountReads.push(`aircraft:${serial}`);
          return { serial, registration: null, type: null, ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: BUSINESS };
        },
        async logbook(serial: number) {
          accountReads.push(`logbook:${serial}`);
          return logbooks;
        },
      },
      publicClient: { pilotAircraftOwner: async () => ({ airlineId: AIRLINE, businessId: BUSINESS }) },
      fetchFn: (async () => new Response(csvOf(g.values), { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch,
      now: () => h.clock.now,
    });
    h.store.setKv(`aero.business.${AIRLINE}`, String(BUSINESS));
    d.ctx.profits = profits;
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is a subcommand Discord accepts, with a check and a fill, and reads and writes nothing by itself', () => {
    const sub = (setup.data.toJSON().options ?? []).find((o) => o.name === 'profit') as unknown as { description: string; options: Array<{ name: string; choices?: Array<{ value: string }> }> };
    assert.ok(sub && sub.description.length <= 100);
    assert.deepEqual(sub.options.find((o) => o.name === 'action')!.choices!.map((c) => c.value), ['check', 'fill']);
    assert.ok(sub.options.some((o) => o.name === 'airline') && sub.options.some((o) => o.name === 'business'));
    assert.deepEqual(accountReads, []);
    assert.equal(g.writes.length, 0);
  });

  it('is for admins only, and a refresh role does not let a member run it', async () => {
    h.store.addRefreshRole(h.panel.guildId, '555', T0);
    const { error } = await run({ admin: false, roles: ['555'] });
    assert.ok(error);
    assert.deepEqual(accountReads, [], 'nothing was read');
  });

  it('checks by default: it reports what agrees, what differs and what is blank, and changes nothing', async () => {
    const { text, components, error } = await run();
    assert.equal(error, null);
    assert.match(text, /Profit check: Test Air/);
    assert.match(text, /\*\*0\*\* have a Profit Made that agrees/);
    assert.match(text, /\*\*1\*\* have a Profit Made that is not what Aeroconomy says/);
    assert.match(text, /row 4 · TST303 EGCC → EGLL · Thu 12 Nov · sheet \$50,000 · Aeroconomy \$49,000/);
    assert.match(text, /\*\*2\*\* have a blank Profit Made/);
    assert.match(text, /row 3 · TST101 EGLL → EGCC · Thu 12 Nov · \$12,346/);
    assert.match(text, /row 5 · TST202 KMIA → KORD · Thu 12 Nov · -\$4,000/);
    assert.match(text, /Nothing was changed\./);
    assert.deepEqual(components, [], 'no button');
    assert.equal(g.writes.length, 0);
    assert.deepEqual(accountReads.sort(), ['fleet:77', 'logbook:151']);
  });

  it('explains a missing token, a panel without the link, and Aeroconomy refusing, in plain words', async () => {
    d.ctx.profits = null;
    assert.match((await run()).error?.message ?? '', /no FsHub token/);
    d.ctx.profits = profits;
    h.store.updatePanel(pid(), { fshubAirlineId: null });
    assert.match((await run()).error?.message ?? '', /isn't linked to its airline's FsHub roster/);
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE });
    d.ctx.profits = new AirlineProfits({ store: h.store, account: { ownedAircraft: async () => Promise.reject(new AeroconomyError("Aeroconomy won't show that.")), aircraft: async () => null, logbook: async () => [] }, publicClient: { pilotAircraftOwner: async () => null }, now: () => T0 });
    assert.equal((await run()).error?.message, "Aeroconomy won't show that.");
  });

  it('with fill, shows exactly what it would write and waits for a button: nothing is written yet', async () => {
    const { text, components } = await run({ options: { action: 'fill' } });
    assert.match(text, /Fill blank Profit Made cells: Test Air/);
    assert.match(text, /\*\*2\*\* Profit Made cells that are empty today/);
    assert.match(text, /row 3 · TST101 EGLL → EGCC · Thu 12 Nov · \$12,346 \(Aeroconomy: \$12,345\.67\)/);
    assert.match(text, /Nothing is written unless you press \*\*Write\*\*/);
    const ids = idsOf(components);
    assert.deepEqual(ids.map((i) => i.split(':').slice(0, 2).join(':')), ['profit:go', 'profit:no']);
    assert.equal(g.writes.length, 0);
    assert.equal(g.cell('J3'), '');
  });

  it('does not offer a cell that has a note in it, and tells the admin it left it alone', async () => {
    g.values[2]![9] = 'TBD'; // row 3 is marked "to be decided" by a manager
    const checked = await run();
    assert.match(checked.text, /\*\*1\*\* have something in Profit Made that is not an amount \(like TBD\): left exactly as it is/);
    assert.match(checked.text, /\*\*1\*\* have a blank Profit Made/);
    const { text, components } = await run({ options: { action: 'fill' } });
    assert.match(text, /\*\*1\*\* Profit Made cell that is empty today/);
    assert.doesNotMatch(text, /row 3 ·/);
    await press(idsOf(components)[0]!);
    assert.equal(g.cell('J3'), 'TBD', 'the note is still there');
    assert.equal(g.cell('J5'), '-4000');
  });

  it('writes when the admin who asked presses Write, only the cells shown, and only once', async () => {
    const { components } = await run({ options: { action: 'fill' } });
    const go = idsOf(components)[0]!;
    const before = g.values.map((r) => [...r]);
    const done = await press(go);
    for (let r = 0; r < Math.max(before.length, g.values.length); r++) {
      for (let c = 0; c < Math.max(before[r]?.length ?? 0, g.values[r]?.length ?? 0); c++) {
        if (c === 9 && (r === 2 || r === 4)) continue;
        assert.equal(g.values[r]?.[c] ?? '', before[r]?.[c] ?? '', `row ${r + 1} column ${c + 1} must not change`);
      }
    }
    assert.match(done.text, /Wrote \*\*2\*\* Profit Made cells in the sheet at <t:\d+:t>: J3, J5/);
    assert.equal(g.cell('J3'), '12346');
    assert.equal(g.cell('J5'), '-4000');
    assert.equal(g.cell('J4'), '$50,000.00', 'the difference is not touched');
    assert.equal(g.cell('J7'), '', 'a row that no logbook flight matched is not touched');
    assert.equal(g.writes.length, 1);
    const again = await press(go);
    assert.match(again.text, /expired or was already used, and nothing was written/);
    assert.equal(g.writes.length, 1);
  });

  it('skips what changed since the preview and says so', async () => {
    const { components } = await run({ options: { action: 'fill' } });
    g.values[2]![9] = '$13,000.00'; // a manager typed one meanwhile
    const done = await press(idsOf(components)[0]!);
    assert.match(done.text, /Wrote \*\*1\*\* Profit Made cell/);
    assert.match(done.text, /Left alone, because they changed since the preview: 1 \(the cell has something in it now\)/);
    assert.equal(g.cell('J3'), '$13,000.00');
    assert.equal(g.cell('J5'), '-4000');
  });

  it('does nothing on Cancel, and nobody but the admin who asked can confirm it', async () => {
    const { components } = await run({ options: { action: 'fill' } });
    const [go, no] = idsOf(components) as [string, string];
    const stranger = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    const refused = await press(go, { user: stranger });
    assert.match(refused.text, /Only the admin who asked for this can confirm it/);
    const notAdmin = await press(go, { admin: false });
    assert.match(notAdmin.text, /Only the admin who asked for this can confirm it/);
    assert.equal(g.writes.length, 0);
    const cancelled = await press(no);
    assert.match(cancelled.text, /Cancelled\. Nothing was written/);
    assert.match((await press(go)).text, /expired or was already used/);
    assert.equal(g.writes.length, 0);
  });

  it('lets a preview expire after ten minutes', async () => {
    const { components } = await run({ options: { action: 'fill' } });
    h.clock.advance(11 * 60_000);
    assert.match((await press(idsOf(components)[0]!)).text, /expired or was already used, and nothing was written/);
    assert.equal(g.writes.length, 0);
  });

  it('will not write when writing to the sheet is not switched on, and says so', async () => {
    h.store.updatePanel(pid(), { writeback: false });
    const { text, components } = await run({ options: { action: 'fill' } });
    assert.match(text, /writing to the sheet isn't switched on for this panel/);
    assert.deepEqual(components, []);
    d.ctx.writeback = null;
    h.store.updatePanel(pid(), { writeback: true });
    assert.match((await run({ options: { action: 'fill' } })).text, /isn't switched on/);
  });

  it('says when there is nothing to fill', async () => {
    g.values = profitGrid().map((r, i) => (i === 2 || i === 4 ? [...r.slice(0, 9), '$1.00'] : r));
    const { text, components } = await run({ options: { action: 'fill' } });
    assert.match(text, /There are no blank Profit Made cells I can fill, so nothing was changed\./);
    assert.deepEqual(components, []);
  });

  it('does not write if the sheet stops being writable between the preview and the button, and says nothing was written', async () => {
    const { components } = await run({ options: { action: 'fill' } });
    g.mode = 'view-only';
    const done = await press(idsOf(components)[0]!);
    assert.match(done.text, /I couldn't write to the sheet, so nothing was written/);
    assert.equal(g.writes.length, 0);
    h.store.updatePanel(pid(), { writeback: false });
    const { components: again } = await run({ options: { action: 'fill' } });
    assert.deepEqual(again, [], 'switched off meanwhile: no button at all');
  });

  it('keeps a report and a preview inside one Discord message however much there is to say', async () => {
    const many: ProfitAnalysis = {
      business: BUSINESS,
      aircraft: 11,
      logbookFlights: 240,
      usableFlights: 230,
      sheetCompleted: 200,
      matched: 190,
      agree: 100,
      fills: Array.from({ length: 40 }, (_, i) => ({ sourceKey: `k${i}`, value: 123456789 + i, row: 100 + i, pilot: 'A Pilot With A Long Name', route: 'EGLL → EGCC', day: D12, callsign: 'TST1234', exact: 123456789.12, flightId: 5000 + i, logbookNm: 4321, pay: 18518518, payPlan: { amount: 18518518, basis: 'share' as const, distanceNm: null, problem: null, cell: 'empty' as const } })),
      different: Array.from({ length: 40 }, (_, i) => ({ row: 10 + i, route: 'EGLL → EGCC', day: D12, callsign: 'TST1234', sheet: -123456789, aeroconomy: 123456789.55 })),
      unreadable: 3,
      unmatched: 5,
      ambiguous: 4,
      readAt: T0,
    };
    const report = profitReport('Test Air', many);
    assert.ok(report.length <= 1800, `${report.length} characters`);
    assert.match(report, /…and \d+ more\./);
    assert.match(report, /\*\*3\*\* have something in Profit Made that is not an amount \(like TBD\): left exactly as it is/);
    assert.doesNotMatch(profitReport('Test Air', { ...many, unreadable: 0 }), /not an amount/);
    assert.ok(previewText('Test Air', many.fills).length <= 1990);
    assert.match(previewText('Test Air', many.fills), /Nothing is written unless you press \*\*Write\*\*/, 'the closing words are never the part that is cut');
  });
});
