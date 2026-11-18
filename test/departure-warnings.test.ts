import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/db/db.js';
import { ROUTE_TIME_MAX_MINUTES, ROUTE_TIME_MIN_MINUTES, Store, type FlownFlight, type RouteTime } from '../src/db/store.js';
import { commands } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { speedFor, speedKindOf } from '../src/services/aircraftSpeeds.js';
import { AirportDirectory, AIRPORTS_URL, greatCircleNm, pickAirports } from '../src/services/airports.js';
import {
  backupWarning,
  DEPART_WARNING_DEFAULT_MINUTES,
  DEPART_WARNING_MAX_MINUTES,
  DEPART_WARNING_MIN_MINUTES,
  DepartureWarnings,
  pilotWarning,
} from '../src/services/departureWarnings.js';
import { distanceTime, FlightTimes, learnedTime, median, MIN_LEARNED_FLIGHTS, ROUTE_FACTOR, type FlightTime } from '../src/services/flightTime.js';
import { Scheduler } from '../src/services/scheduler.js';
import { durationText, ts } from '../src/util/format.js';
import { HOUR, T0, USER_A, USER_B, USER_C, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

/* Everything below is made up: the pilots, the airline and the flights. The airports are real, because the positions are what is under test. */

const MIN = 60_000;
const DAY = 24 * HOUR;
const setup = commands.find((c) => c.data.name === 'setup')!;

/* ------------------------------------------------------------------ how long a flight takes */

describe('durations in words', () => {
  it('writes minutes, hours, and both', () => {
    assert.equal(durationText(45), '45 min');
    assert.equal(durationText(120), '2 h');
    assert.equal(durationText(118), '1 h 58 min');
    assert.equal(durationText(0), '0 min');
    assert.equal(durationText(59.6), '1 h', 'rounded to a whole minute first');
  });
});

describe('typical speeds', () => {
  it('knows the kind of an aircraft, and says so when it does not', () => {
    assert.deepEqual([speedFor('A320').kind, speedFor('A320').known], ['narrowbody', true]);
    assert.equal(speedFor('B77W').kind, 'widebody');
    assert.equal(speedFor('CRJ9').kind, 'regional');
    assert.equal(speedFor('C172').kind, 'piston');
    assert.equal(speedFor('PC12').kind, 'fastprop');
    assert.equal(speedFor('R44').kind, 'helicopter');
    assert.equal(speedFor('a320').kind, 'narrowbody', 'any case');
    const unknown = speedFor('ZZZZ');
    assert.deepEqual([unknown.known, unknown.kind, unknown.label], [false, null, 'a typical airliner']);
    assert.equal(speedFor(null).known, false);
    assert.equal(speedKindOf('ZZZZ'), null);
  });

  it('is slower for the smaller aircraft, with the odd type having a speed of its own', () => {
    assert.ok(speedFor('B77W').kt > speedFor('A320').kt);
    assert.ok(speedFor('A320').kt > speedFor('AT76').kt);
    assert.ok(speedFor('AT76').kt > speedFor('C172').kt);
    assert.equal(speedFor('DC3').kt, 150, 'an override beats its kind');
    assert.equal(speedFor('C172').kt, 105);
  });
});

describe('distances between airports', () => {
  const lhr = { lat: 51.4706, lon: -0.461941 };
  const lgw = { lat: 51.148102, lon: -0.190278 };
  const ord = { lat: 41.9786, lon: -87.9048 };
  const lax = { lat: 33.942501, lon: -118.407997 };

  it('is the great-circle distance in nautical miles', () => {
    assert.ok(Math.abs(greatCircleNm(lhr, lgw) - 21.9) < 1.5, `${greatCircleNm(lhr, lgw)}`);
    assert.ok(Math.abs(greatCircleNm(ord, lax) - 1523) < 20, `${greatCircleNm(ord, lax)}`);
    assert.equal(greatCircleNm(lhr, lhr), 0);
    assert.ok(Math.abs(greatCircleNm(ord, lax) - greatCircleNm(lax, ord)) < 1e-9, 'the same either way');
  });

  it('works out a time at the typical speed, with a little extra for the route and the climb and approach', () => {
    const t = distanceTime(1000, 'A320'); // narrowbody: 440 kt, 20 minutes
    assert.equal(t.minutes, Math.round(((1000 * ROUTE_FACTOR) / 440) * 60 + 20));
    assert.equal(t.source, 'distance');
    assert.match(t.basis, /^estimated from the 1,000 nm between the airports \(plus 5% for the route\) at the typical speed of a narrowbody airliner \(440 kt\), with 20 minutes added for the climb and the approach$/);
    assert.ok(distanceTime(1000, 'AT76').minutes > t.minutes, 'a turboprop takes longer');
  });

  it('says when it had to assume an aircraft', () => {
    assert.match(distanceTime(500, 'ZZZZ').basis, /a typical airliner \(440 kt\), because the aircraft type is not one the bot has a speed for/);
    assert.match(distanceTime(500, null).basis, /because the aircraft type is not one the bot has a speed for/);
  });
});

describe('the usual time of a route, from flights seen on it', () => {
  const rt = (minutes: number, aircraftIcao: string | null, day = 0): RouteTime => ({ minutes, aircraftIcao, arrivedAt: T0 - day * DAY });

  it('is the median', () => {
    assert.equal(median([5]), 5);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([100, 10, 11]), 11, 'one odd flight does not move it');
  });

  it('needs at least two flights: one may be an odd one', () => {
    assert.equal(MIN_LEARNED_FLIGHTS, 2);
    assert.equal(learnedTime([rt(120, 'A320')], 'A320'), null);
    assert.deepEqual(learnedTime([rt(120, 'A320'), rt(130, 'A320')], 'A320'), { minutes: 125, count: 2, scope: 'type' });
  });

  it('prefers flights in the same aircraft, then the same kind of aircraft, and never flights in a different kind', () => {
    const times = [rt(120, 'A320'), rt(124, 'A320'), rt(200, 'AT76'), rt(210, 'AT76'), rt(90, 'B738')];
    assert.deepEqual(learnedTime(times, 'A320'), { minutes: 122, count: 2, scope: 'type' });
    // One A20N flight is not enough on its own, but the A20N counts as an A320 for FsHub, so both A320 flights and it are used.
    assert.deepEqual(learnedTime([...times, rt(130, 'A20N')], 'A320'), { minutes: 124, count: 3, scope: 'type' });
    // An F100 job: no F100 flights (and no alias of it), but the narrowbody flights are the same kind.
    assert.deepEqual(learnedTime(times, 'F100'), { minutes: 120, count: 3, scope: 'kind' }, 'A320 x2 and B738');
    // A helicopter job on a route only airliners have flown: no figure.
    assert.equal(learnedTime(times, 'R44'), null);
    // A type the bot does not know and nobody has flown: no figure.
    assert.equal(learnedTime(times, 'ZZZZ'), null);
  });

  it('uses every flight when the job names no aircraft', () => {
    assert.deepEqual(learnedTime([rt(100, 'A320'), rt(110, 'AT76'), rt(120, null)], null), { minutes: 110, count: 3, scope: 'any' });
    assert.equal(learnedTime([rt(100, 'A320')], null), null);
  });
});

/* ------------------------------------------------------------------ where airports are */

const CSV = [
  'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,wikipedia_link,keywords',
  '3632,EGLL,large_airport,London Heathrow Airport,51.4706,-0.461941,83,EU,GB,GB-ENG,London,yes,EGLL,LHR,EGLL,,,,',
  '3626,EGKK,large_airport,London Gatwick Airport,51.148102,-0.190278,202,EU,GB,GB-ENG,London,yes,EGKK,LGW,EGKK,,,,',
  '3878,KORD,large_airport,"Chicago O\'Hare, International Airport",41.9786,-87.9048,672,NA,US,US-IL,Chicago,yes,KORD,ORD,KORD,ORD,,,',
  '3484,KLAX,large_airport,Los Angeles International Airport,33.942501,-118.407997,128,NA,US,US-CA,Los Angeles,yes,KLAX,LAX,KLAX,LAX,,,',
  '9001,ZZZZ,closed,Old field that closed,10.0,10.0,1,EU,GB,GB-ENG,Nowhere,no,,,,,,,',
  '9002,K1AA,small_airport,Small field,40.0,-100.0,1,NA,US,US-NE,Somewhere,no,,,KTST,,,,',
  '9003,KTST,small_airport,The real KTST,41.0,-101.0,1,NA,US,US-NE,Elsewhere,no,KTST,,KTST,,,,',
  '9004,XNOCO,small_airport,No position,,,1,NA,US,US-NE,Elsewhere,no,,,,,,,',
  '9005,KHEL,heliport,A helipad,42.0,-100.0,1,NA,US,US-NE,Nowhere,no,KHEL,,KHEL,,,,',
  '9006,KMED,medium_airport,A medium airport,43.0,-99.0,1,NA,US,US-NE,Somewhere,no,KMED,,KMED,,,,',
  '9007,US-12345,small_airport,A code no flight uses,44.0,-98.0,1,NA,US,US-NE,Somewhere,no,,,,,,,',
].join('\n');

describe('reading the airport list', () => {
  const pick = (...codes: string[]) => pickAirports(CSV, new Set(codes));

  it('finds the positions of the airports asked for, and only those', () => {
    const found = pick('EGLL', 'KLAX', 'NOPE')!;
    assert.deepEqual(found.map((a) => a.code).sort(), ['EGLL', 'KLAX']);
    const egll = found.find((a) => a.code === 'EGLL')!;
    assert.deepEqual([egll.lat, egll.lon, egll.name], [51.4706, -0.461941, 'London Heathrow Airport']);
  });

  it('reads a quoted name with a comma and a quote in it', () => {
    assert.equal(pick('KORD')![0]!.name, "Chicago O'Hare, International Airport");
  });

  it('leaves out a closed airport, and one with no position', () => {
    assert.deepEqual(pick('ZZZZ', 'XNOCO'), []);
  });

  it("gives a code to the airport whose own identifier it is, not to another airport that lists it as its GPS code", () => {
    const [a] = pick('KTST')!;
    assert.deepEqual([a!.lat, a!.lon], [41, -101]);
  });

  it('is not fooled by a file that is not the list', () => {
    assert.equal(pickAirports('', new Set(['EGLL'])), null);
    assert.equal(pickAirports('<html>not a csv</html>', new Set(['EGLL'])), null);
    assert.equal(pickAirports('a,b,c\n1,2,3', new Set(['EGLL'])), null);
  });
});

describe('the airport directory', () => {
  let h: Harness;
  let calls: Array<{ url: string; headers: Record<string, string> }>;
  let reply: () => Response;
  let dir: AirportDirectory;
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return reply();
  };

  beforeEach(async () => {
    h = await makeHarness();
    calls = [];
    reply = () => new Response(CSV, { status: 200 });
    dir = new AirportDirectory(h.store, { fetchFn: fakeFetch, now: () => h.clock.now, userAgent: 'FlightPanelBot/test' });
  });
  afterEach(() => h.close());

  it('downloads the public list once, asks nothing else, and keeps the positions of the airports wanted', async () => {
    const got = await dir.coords(['egll', 'EGKK']);
    assert.deepEqual([...got.keys()].sort(), ['EGKK', 'EGLL']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, AIRPORTS_URL);
    assert.equal(calls[0]!.headers['user-agent'], 'FlightPanelBot/test');
    assert.equal(h.store.getAirportCoords(['EGLL']).get('EGLL')!.lat, 51.4706, 'kept for next time');
  });

  it('never downloads for airports it already has', async () => {
    await dir.coords(['EGLL', 'EGKK']);
    await dir.coords(['EGLL', 'EGKK']);
    await dir.coords(['EGKK']);
    assert.equal(calls.length, 1);
  });

  it('does not download again for an airport the list turned out not to have, until half a day has passed', async () => {
    const first = await dir.coords(['EGLL', 'NOPE']);
    assert.deepEqual([...first.keys()], ['EGLL']);
    await dir.coords(['NOPE']);
    await dir.coords(['NOPE', 'EGLL']);
    assert.equal(calls.length, 1, 'an airport that is not in the list is not looked for every minute');
    h.clock.advance(13 * HOUR);
    await dir.coords(['NOPE']);
    assert.equal(calls.length, 2, 'but is looked for again later');
  });

  it('keeps every airport in the list when it reads it, not only the ones asked about', async () => {
    await dir.coords(['EGLL']);
    assert.deepEqual([...h.store.getAirportCoords(['EGLL', 'EGKK', 'KORD', 'KLAX', 'KTST', 'K1AA', 'KMED']).keys()].sort(), ['EGKK', 'EGLL', 'K1AA', 'KLAX', 'KMED', 'KORD', 'KTST'], 'large, medium and small airports');
    assert.equal(h.store.getAirportCoords(['US-12345']).size, 0, 'a code that cannot be one a flight uses');
    assert.equal(calls.length, 1);
  });

  it('says in the log how many of the airports asked about it found, and how many it kept in all', async () => {
    const lines: string[] = [];
    const logging = new AirportDirectory(h.store, { fetchFn: fakeFetch, now: () => h.clock.now, logger: { debug() {}, info: (m: string) => void lines.push(m), warn() {}, error() {} } as any });
    await logging.coords(['EGLL', 'KLAX', 'NOPE']);
    assert.deepEqual(lines, ['Read the airport list: found 2 of 3 airport(s) wanted (7 airports kept in all)']);
  });

  it('leaves out a closed airport, one with no position, and one of a kind no flight uses unless somebody asked for it by its code', async () => {
    await dir.coords(['EGLL']);
    assert.deepEqual([...h.store.getAirportCoords(['ZZZZ', 'XNOCO', 'KHEL']).keys()], []);
    await dir.coords(['EGLL', 'KHEL']);
    assert.equal(calls.length, 1, 'a heliport is not in what was kept, but one read has been made lately');
    h.clock.advance(13 * HOUR);
    const got = await dir.coords(['KHEL']);
    assert.deepEqual([...got.keys()], ['KHEL'], 'asked for by its code, it is found and kept');
    assert.equal(calls.length, 2);
    assert.equal(h.store.getAirportCoords(['KHEL']).size, 1);
  });

  it('knows every airport after one read, so a new one turning up soon after needs no more reading', async () => {
    await dir.coords(['EGLL']);
    h.clock.advance(11 * MIN);
    const got = await dir.coords(['EGLL', 'KLAX', 'KORD']);
    assert.equal(calls.length, 1);
    assert.deepEqual([...got.keys()].sort(), ['EGLL', 'KLAX', 'KORD']);
  });

  it('reads the list again for a code that is not in it, but only after half a day, and then once', async () => {
    await dir.coords(['EGLL', 'NOPE']);
    h.clock.advance(11 * MIN);
    await dir.coords(['NOPE']);
    await dir.coords(['NOPE', 'EGKK']);
    assert.equal(calls.length, 1);
    h.clock.advance(12 * HOUR - 11 * MIN - 1);
    await dir.coords(['NOPE']);
    assert.equal(calls.length, 1, 'a moment short of half a day since the read');
    h.clock.advance(1);
    await dir.coords(['NOPE']);
    assert.equal(calls.length, 2, 'half a day exactly');
    await dir.coords(['NOPE']);
    assert.equal(calls.length, 2, 'and not again at once');
  });

  it('is never read twice within ten minutes, even by an install an earlier version left with only some of its airports', async () => {
    h.store.saveAirportCoords([{ code: 'EGLL', lat: 51.4706, lon: -0.4619, name: 'London Heathrow' }]);
    h.store.setKv('airports.fetched_at', String(h.clock.now - 9 * MIN - 59_000));
    assert.deepEqual([...(await dir.coords(['KLAX'])).keys()], [], 'a second short of ten minutes');
    assert.equal(calls.length, 0);
    h.clock.advance(1_000);
    assert.deepEqual([...(await dir.coords(['KLAX'])).keys()], ['KLAX'], 'ten minutes exactly');
    assert.equal(calls.length, 1);
  });

  it('fills in everything after an upgrade, when an earlier version read the list an hour ago for only some airports', async () => {
    // The state of an install from before the whole list was kept: the list was read, only the airports asked about at the time are known.
    h.store.saveAirportCoords([{ code: 'EGLL', lat: 51.4706, lon: -0.4619, name: 'London Heathrow' }]);
    h.store.setKv('airports.fetched_at', String(h.clock.now - HOUR));
    const got = await dir.coords(['EGLL', 'EGKK', 'KORD']);
    assert.equal(calls.length, 1);
    assert.deepEqual([...got.keys()].sort(), ['EGKK', 'EGLL', 'KORD']);
    assert.equal(h.store.getAirportCoords(['KLAX', 'KTST']).size, 2, 'and the others, which nobody has asked about yet');
    await dir.coords(['KLAX']);
    assert.equal(calls.length, 1, 'with nothing more to read');
  });

  it('does not treat a read from before the whole list was kept as a full one, however recent', async () => {
    h.store.saveAirportCoords([{ code: 'EGLL', lat: 51.4706, lon: -0.4619, name: 'London Heathrow' }]);
    h.store.setKv('airports.fetched_at', String(h.clock.now - 11 * MIN));
    await dir.coords(['KLAX']);
    assert.equal(calls.length, 1);
  });

  it('makes one download for several askers at once, and each gets the airports it asked for, not only the first asker', async () => {
    const [a, b] = await Promise.all([dir.coords(['EGLL']), dir.coords(['KLAX', 'KORD'])]);
    assert.equal(calls.length, 1);
    assert.deepEqual([...a.keys()], ['EGLL']);
    assert.deepEqual([...b.keys()].sort(), ['KLAX', 'KORD']);
  });

  it('ignores a code that cannot be an airport, and a request with nothing to find', async () => {
    assert.deepEqual([...(await dir.coords(['', 'not an airport!', 'x'])).keys()], []);
    assert.equal(calls.length, 0);
  });

  it('copes with the list being down: nothing found, no crash, and a pause of an hour before it tries again', async () => {
    reply = () => new Response('nope', { status: 503 });
    assert.deepEqual([...(await dir.coords(['EGLL'])).keys()], []);
    await dir.coords(['EGLL']);
    h.clock.advance(30 * MIN);
    await dir.coords(['EGLL']);
    assert.equal(calls.length, 1);
    h.clock.advance(31 * MIN);
    reply = () => new Response(CSV, { status: 200 });
    assert.deepEqual([...(await dir.coords(['EGLL'])).keys()], ['EGLL']);
    assert.equal(calls.length, 2);
  });

  it('copes with the network failing, and with a file that is not the list', async () => {
    reply = () => {
      throw new Error('socket hang up');
    };
    assert.deepEqual([...(await dir.coords(['EGLL'])).keys()], []);
    h.clock.advance(2 * HOUR);
    reply = () => new Response('<html>Gateway</html>', { status: 200 });
    assert.deepEqual([...(await dir.coords(['EGLL'])).keys()], []);
    assert.equal(h.store.getAirportCoords(['EGLL']).size, 0, 'nothing wrong was kept');
  });

  it('refuses a list far bigger than it should be', async () => {
    reply = () => new Response(CSV, { status: 200, headers: { 'content-length': '999999999' } });
    assert.deepEqual([...(await dir.coords(['EGLL'])).keys()], [], 'even though what came was a good list');
  });
});

/* ------------------------------------------------------------------ what the store keeps */

let seq = 1000;
const fl = (over: Partial<FlownFlight> = {}): FlownFlight => ({
  flightId: ++seq,
  pilotId: 500,
  pilotName: 'Ann Pilot',
  dep: 'EGLL',
  arr: 'EGKK',
  departedAt: T0,
  arrivedAt: T0 + 2 * HOUR,
  aircraftIcao: 'A320',
  aircraftName: 'Airbus A320',
  scheduleStatus: 'ON-TIME',
  ...over,
});

describe('learning how long a route takes', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());
  const pid = () => h.panel.id;

  it('keeps how long each flight took, most recent first', () => {
    h.store.upsertFshubFlights(pid(), [fl({ departedAt: T0 - 5 * DAY, arrivedAt: T0 - 5 * DAY + 100 * MIN }), fl({ departedAt: T0 - DAY, arrivedAt: T0 - DAY + 110 * MIN, aircraftIcao: 'a20n' })]);
    assert.deepEqual(h.store.listRouteTimes(pid(), 'egll', 'egkk'), [
      { minutes: 110, aircraftIcao: 'A20N', arrivedAt: T0 - DAY + 110 * MIN },
      { minutes: 100, aircraftIcao: 'A320', arrivedAt: T0 - 5 * DAY + 100 * MIN },
    ]);
    assert.deepEqual(h.store.listRouteTimes(pid(), 'EGKK', 'EGLL'), [], 'the other way is another route');
    assert.equal(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK', 1).length, 1);
  });

  it('keeps one time per flight, however often the flight is read', () => {
    const f = fl();
    h.store.upsertFshubFlights(pid(), [f]);
    h.store.upsertFshubFlights(pid(), [f, f]);
    assert.equal(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK').length, 1);
  });

  it('leaves out a flight with no take-off time, and a time too short or too long to be believed', () => {
    h.store.upsertFshubFlights(pid(), [
      fl({ departedAt: null }),
      fl({ departedAt: T0, arrivedAt: T0 + (ROUTE_TIME_MIN_MINUTES - 1) * MIN }),
      fl({ departedAt: T0, arrivedAt: T0 + (ROUTE_TIME_MAX_MINUTES + 1) * MIN }),
      fl({ departedAt: T0 + HOUR, arrivedAt: T0 }),
    ]);
    assert.deepEqual(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK'), []);
    h.store.upsertFshubFlights(pid(), [fl({ departedAt: T0, arrivedAt: T0 + ROUTE_TIME_MIN_MINUTES * MIN }), fl({ departedAt: T0, arrivedAt: T0 + ROUTE_TIME_MAX_MINUTES * MIN })]);
    assert.equal(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK').length, 2, 'the limits themselves are fine');
  });

  it("outlives the flights themselves, which are forgotten after a week, but not the panel", () => {
    h.store.upsertFshubFlights(pid(), [fl({ departedAt: T0 - 9 * DAY, arrivedAt: T0 - 9 * DAY + 2 * HOUR })]);
    h.store.pruneFshubFlights(pid(), T0 - 7 * DAY);
    assert.equal(h.store.countFshubFlights(pid()), 0);
    assert.equal(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK').length, 1);
    h.store.clearFshubFlights(pid());
    assert.equal(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK').length, 1, 'unlinking FsHub keeps what was learned');
    h.store.deletePanel(pid());
    assert.equal(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK').length, 0, 'but deleting the panel takes it');
  });

  it('forgets times older than the cut-off', () => {
    h.store.upsertFshubFlights(pid(), [fl({ departedAt: T0 - 300 * DAY, arrivedAt: T0 - 300 * DAY + 2 * HOUR }), fl()]);
    assert.equal(h.store.pruneRouteTimes(T0 - 180 * DAY), 1);
    assert.equal(h.store.listRouteTimes(pid(), 'EGLL', 'EGKK').length, 1);
  });

  it('keeps each airline\'s own times', () => {
    const other = h.store.createPanel({ guildId: '900000000000000009', name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '700000000000000009', now: T0 });
    h.store.upsertFshubFlights(pid(), [fl()]);
    assert.equal(h.store.listRouteTimes(other.id, 'EGLL', 'EGKK').length, 0);
  });
});

describe('the airports and warnings the store keeps', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('keeps airport positions, any case, and replaces them when read again', () => {
    h.store.saveAirportCoords([{ code: 'egll', lat: 1, lon: 2, name: 'A' }]);
    h.store.saveAirportCoords([{ code: 'EGLL', lat: 51, lon: -0.4, name: 'Heathrow' }]);
    assert.deepEqual(h.store.getAirportCoords(['EGLL', 'egkk']).get('EGLL'), { lat: 51, lon: -0.4, name: 'Heathrow' });
    assert.equal(h.store.getAirportCoords(['EGLL', 'EGKK']).size, 1);
  });

  it('remembers who was warned about a flight, and forgets it with the flight', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    const job = h.jobs.open(h.panel.id)[0]!.job;
    assert.equal(h.store.wasWarned(job.id, USER_A.discordId), false);
    h.store.markWarned(job.id, USER_A.discordId, T0);
    h.store.markWarned(job.id, USER_A.discordId, T0 + 1);
    assert.equal(h.store.wasWarned(job.id, USER_A.discordId), true);
    assert.equal(h.store.wasWarned(job.id, USER_B.discordId), false, 'each person on their own');
  });

  it('gives every panel the warning, 30 minutes before, and allows 0 to 180', () => {
    assert.equal(h.store.getPanel(h.panel.id)!.departWarningMinutes, 30);
    assert.equal(DEPART_WARNING_DEFAULT_MINUTES, 30);
    h.store.updatePanel(h.panel.id, { departWarningMinutes: 0 });
    assert.equal(h.store.getPanel(h.panel.id)!.departWarningMinutes, 0);
    h.store.updatePanel(h.panel.id, { departWarningMinutes: 180 });
    assert.equal(h.store.getPanel(h.panel.id)!.departWarningMinutes, 180);
    assert.throws(() => h.store.updatePanel(h.panel.id, { departWarningMinutes: 181 }), /0 \(off\) to 180/);
    assert.throws(() => h.store.updatePanel(h.panel.id, { departWarningMinutes: -1 }), /0 \(off\) to 180/);
    assert.throws(() => h.store.updatePanel(h.panel.id, { departWarningMinutes: 1.5 }), /0 \(off\) to 180/);
  });

  it('upgrades a v23 database: panels start with the warning on, and the new tables are there', () => {
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < 23; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    assert.ok(MIGRATIONS.length >= 24);
    for (let v = 23; v < MIGRATIONS.length; v++) old.exec(MIGRATIONS[v] as string);
    const store = new Store(old);
    assert.equal(store.listAllPanels()[0]!.departWarningMinutes, 30);
    assert.deepEqual(store.listRouteTimes(store.listAllPanels()[0]!.id, 'EGLL', 'EGKK'), []);
    assert.equal(store.getAirportCoords(['EGLL']).size, 0);
  });
});

/* ------------------------------------------------------------------ the time for a leg */

describe('the time for a leg', () => {
  let h: Harness;
  let wanted: string[][];
  let known: Map<string, { lat: number; lon: number; name: string | null }>;
  let times: FlightTimes;
  beforeEach(async () => {
    h = await makeHarness();
    wanted = [];
    known = new Map([
      ['EGLL', { lat: 51.4706, lon: -0.461941, name: 'Heathrow' }],
      ['EGKK', { lat: 51.148102, lon: -0.190278, name: 'Gatwick' }],
      ['KORD', { lat: 41.9786, lon: -87.9048, name: "O'Hare" }],
      ['KLAX', { lat: 33.942501, lon: -118.407997, name: 'LAX' }],
    ]);
    times = new FlightTimes(h.store, {
      coords: async (codes: string[]) => {
        wanted.push(codes);
        return new Map(codes.filter((c) => known.has(c)).map((c) => [c, known.get(c)!]));
      },
    });
  });
  afterEach(() => h.close());
  const panel = () => h.store.getPanel(h.panel.id)!;
  const learn = (dep: string, arr: string, minutes: number[], aircraftIcao = 'A320') =>
    h.store.upsertFshubFlights(h.panel.id, minutes.map((m, i) => fl({ dep, arr, aircraftIcao, departedAt: T0 - (i + 1) * DAY, arrivedAt: T0 - (i + 1) * DAY + m * MIN })));

  it('is learned from the airline\'s own flights when there are enough, and says so, without looking at a map', async () => {
    learn('KORD', 'KLAX', [235, 245, 240]);
    const t = (await times.forLeg(panel(), 'kord', 'klax', 'A320'))!;
    assert.deepEqual([t.minutes, t.source], [240, 'learned']);
    assert.equal(t.basis, "the middle time of the 3 flights of this route by your airline's pilots on FsHub, in the A320");
    assert.deepEqual(wanted, [], 'it did not need the airports');
  });

  it('says it was the same kind of aircraft when that is what it used, and nothing when the job names no aircraft', async () => {
    learn('KORD', 'KLAX', [240, 250], 'B738');
    assert.match((await times.forLeg(panel(), 'KORD', 'KLAX', 'A321'))!.basis, /^the middle time of the 2 flights of this route by your airline's pilots on FsHub, in a narrowbody airliner$/);
    assert.match((await times.forLeg(panel(), 'KORD', 'KLAX', null))!.basis, /^the middle time of the 2 flights of this route by your airline's pilots on FsHub$/);
  });

  it('uses the flights seen when the job names its aircraft in words, which cannot be matched to a type', async () => {
    learn('KORD', 'KLAX', [240, 250], 'A320');
    const t = (await times.forLeg(panel(), 'KORD', 'KLAX', 'Airbus A320'))!;
    assert.deepEqual([t.minutes, t.source], [245, 'learned']);
    assert.match(t.basis, /^the middle time of the 2 flights of this route by your airline's pilots on FsHub$/);
  });

  it('estimates from the distance when too few flights have been seen, and says so', async () => {
    learn('KORD', 'KLAX', [240]);
    const t = (await times.forLeg(panel(), 'KORD', 'KLAX', 'A320'))!;
    assert.equal(t.source, 'distance');
    assert.match(t.basis, /^estimated from the 1,5\d\d nm between the airports/);
    assert.deepEqual(wanted, [['KORD', 'KLAX']]);
    assert.ok(t.minutes > 200 && t.minutes < 270, `${t.minutes}`);
  });

  it('estimates from the distance when the flights seen were in a different kind of aircraft', async () => {
    learn('EGLL', 'EGKK', [40, 45], 'AT76');
    assert.equal((await times.forLeg(panel(), 'EGLL', 'EGKK', 'R44'))!.source, 'distance');
  });

  it('has no time at all when it knows neither a flight of the route nor where both airports are', async () => {
    assert.equal(await times.forLeg(panel(), 'EGLL', 'XXXX', 'A320'), null);
    assert.equal(await times.forLeg(panel(), 'XXXX', 'EGLL', 'A320'), null);
  });
});

/* ------------------------------------------------------------------ the warning itself */

const learned = (minutes: number): FlightTime => ({ minutes, source: 'learned', basis: `the middle time of the 6 flights of this route by your airline's pilots on FsHub, in the A320` });

describe('warning a pilot before the latest take-off', () => {
  let h: Harness;
  let sent: Array<{ to: string; content: string }>;
  let deliverable: boolean;
  let durations: Map<string, FlightTime | null>;
  let svc: DepartureWarnings;
  const pid = () => h.panel.id;
  const view = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!;
  const at = (hours: number) => T0 + hours * HOUR;
  const run = () => svc.run();
  const to = (user: { discordId: string }) => sent.filter((s) => s.to === user.discordId);
  /** The flight: 2 hours long, down by 19:00Z (T0 is 12:00Z, so 7 hours on), taken by Alice with Bob as her backup. */
  const taken = (over: Parameters<typeof sj>[2] = {}, chain = 'EGLL-EGKK') => {
    h.jobs.sync(pid(), [sj('a', chain, { availableFrom: at(-2), deadline: at(7), ...over })]);
    h.jobs.reserve(view('a').job.id, view('a').legs.map((l) => l.legNo), USER_A);
    h.jobs.addBackup(view('a').job.id, USER_B);
  };

  beforeEach(async () => {
    h = await makeHarness();
    sent = [];
    deliverable = true;
    durations = new Map([['EGLL-EGKK', learned(120)], ['EGKK-EGCC', learned(60)]]);
    svc = new DepartureWarnings(
      h.store,
      h.jobs,
      { forLeg: async (_panel, dep, arr) => durations.get(`${dep}-${arr}`) ?? null },
      async (id, content) => {
        sent.push({ to: id, content });
        return deliverable;
      },
      { now: () => h.clock.now },
    );
  });
  afterEach(() => h.close());

  describe('when', () => {
    it('is 30 minutes before the latest take-off: a 2 hour flight that must be down by 19:00 is warned about at 16:30 for a 17:00 take-off', async () => {
      taken();
      h.clock.now = at(4.5) - MIN; // 16:29
      assert.equal(await run(), 0);
      h.clock.now = at(4.5); // 16:30
      assert.equal(await run(), 2, 'the pilot and the backup');
      assert.deepEqual(sent.map((s) => s.to).sort(), [USER_A.discordId, USER_B.discordId].sort());
      assert.ok(sent.every((s) => s.content.includes(`**${ts(at(5), 't')}**`)), 'both told 17:00');
      assert.ok(sent.every((s) => s.content.includes(ts(at(7), 'f'))), 'and when it must be down by');
    });

    it('is only once for each person', async () => {
      taken();
      h.clock.now = at(4.5);
      await run();
      h.clock.advance(MIN);
      await run();
      h.clock.advance(10 * MIN);
      await run();
      assert.equal(sent.length, 2);
    });

    it('does not warn after the latest take-off has passed: the pilot is flying, or has lost the window, and nobody can tell which', async () => {
      taken();
      h.clock.now = at(5);
      assert.equal(await run(), 0);
      h.clock.now = at(5.5);
      assert.equal(await run(), 0);
    });

    it('warns at once for a flight taken when the time is already close', async () => {
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) })]);
      h.clock.now = at(4.75); // 16:45, 15 minutes to go
      h.jobs.reserve(view('a').job.id, [1], USER_A);
      assert.equal(await run(), 1);
      assert.match(sent[0]!.content, /need to take off by/);
    });

    it('follows the time the server chose, and nothing at all when it is off', async () => {
      taken();
      h.store.updatePanel(pid(), { departWarningMinutes: 90 });
      h.clock.now = at(3.4); // 15:24, more than 90 minutes before 17:00
      assert.equal(await run(), 0);
      h.clock.now = at(3.5);
      assert.equal(await run(), 2);

      sent = [];
      h.store.updatePanel(pid(), { departWarningMinutes: 0 });
      h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) }), sj('b', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(5.2) })]);
      h.jobs.reserve(view('b').job.id, [1], USER_C);
      assert.equal(await run(), 0, 'off is off');
    });

    it('follows the flight\'s length: a longer flight has to leave earlier', async () => {
      taken();
      durations.set('EGLL-EGKK', learned(240)); // latest take-off 15:00
      h.clock.now = at(2.5);
      assert.equal(await run(), 2);
      assert.ok(sent.every((s) => s.content.includes(`**${ts(at(3), 't')}**`)));
    });

    it('looks at nothing that is a long way off', async () => {
      taken({ deadline: at(100) });
      h.clock.now = at(0);
      let asked = 0;
      svc = new DepartureWarnings(h.store, h.jobs, { forLeg: async () => (asked++, learned(120)) }, async () => true, { now: () => h.clock.now });
      assert.equal(await svc.run(), 0);
      assert.equal(asked, 0);
    });
  });

  describe('who', () => {
    it('is the pilot and the backup, each told the right thing', async () => {
      taken();
      h.clock.now = at(4.5);
      await run();
      const pilot = to(USER_A)[0]!.content;
      const backup = to(USER_B)[0]!.content;
      assert.match(pilot, /you need to take off by/);
      assert.match(pilot, /give it back from \*\*My flights\*\*/);
      assert.doesNotMatch(pilot, /backup/);
      assert.match(backup, /you are down as its backup/);
      assert.ok(backup.includes(`<@${USER_A.discordId}>`), 'names who is flying it');
      assert.doesNotMatch(backup, /My flights/);
    });

    it('is nobody for a flight nobody holds, and for one the airline\'s sheet names a pilot for', async () => {
      h.jobs.sync(pid(), [sj('open', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) })]);
      const named = sj('named', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) });
      named.legs[0]!.heldBy = 'Taylor';
      h.jobs.sync(pid(), [sj('open', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) }), named]);
      h.clock.now = at(4.5);
      assert.equal(await run(), 0);
    });

    it('is the pilot, not the backup, when a pilot is also the backup of nothing else, and each pilot of a flight with two', async () => {
      h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC', { availableFrom: at(-2), deadline: at(7) })]);
      h.jobs.reserve(view('m').job.id, [1], USER_A);
      h.jobs.reserve(view('m').job.id, [2], USER_C);
      h.jobs.addBackup(view('m').job.id, USER_B);
      // Leg 1 and 2 together are 3 hours: the latest take-off is 16:00. Leg 2's own pilot has less to fly, so a later time.
      h.clock.now = at(3.5);
      assert.equal(await run(), 2, 'Alice (from leg 1) and Bob (the backup, from leg 1); Carol only has leg 2, which takes an hour: latest 18:00');
      assert.deepEqual(sent.map((s) => s.to).sort(), [USER_A.discordId, USER_B.discordId].sort());
      h.clock.now = at(5.5);
      assert.equal(await run(), 1);
      assert.equal(sent.at(-1)!.to, USER_C.discordId);
      assert.ok(sent.at(-1)!.content.includes(`**${ts(at(6), 't')}**`), 'leg 2 alone: down by 19:00 less an hour is 18:00');
    });

    it('is a new pilot when the flight changes hands, but not the same one twice', async () => {
      taken();
      h.clock.now = at(4.5);
      await run();
      sent = [];
      h.jobs.release(view('a').job.id, USER_A.discordId, [1]);
      h.jobs.reserve(view('a').job.id, [1], USER_C);
      h.clock.advance(5 * MIN);
      assert.equal(await run(), 1);
      assert.equal(sent[0]!.to, USER_C.discordId);
      h.jobs.release(view('a').job.id, USER_C.discordId, [1]);
      h.jobs.reserve(view('a').job.id, [1], USER_A);
      h.clock.advance(5 * MIN);
      assert.equal(await run(), 0, 'Alice has been told about this flight already');
    });

    it('is not a backup for a flight that has lost its pilot', async () => {
      taken();
      h.jobs.release(view('a').job.id, USER_A.discordId, [1]);
      h.clock.now = at(4.5);
      assert.equal(await run(), 0);
    });
  });

  describe('which flights', () => {
    it('is none that are completed, over, or without an end to their window', async () => {
      h.jobs.sync(pid(), [sj('done', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) }), sj('noend', 'EGLL-EGKK', { availableFrom: at(-2), deadline: null }), sj('over', 'EGLL-EGKK', { availableFrom: at(-9), deadline: at(4) })]);
      for (const k of ['done', 'noend', 'over']) h.jobs.reserve(view(k).job.id, [1], USER_A);
      h.store.updateJob(view('done').job.id, { completedAt: at(4) });
      h.clock.now = at(4.5);
      assert.equal(await run(), 0);
    });

    it('counts a flight from the first leg FsHub has not shown flown', async () => {
      taken({}, 'EGLL-EGKK-EGCC'); // legs of 2 h and 1 h, down by 19:00: leaves by 16:00
      h.store.updatePanel(pid(), { fshubAirlineId: 8123, fshubAirlineName: 'Test Air' });
      h.store.upsertFshubFlights(pid(), [fl({ dep: 'EGLL', arr: 'EGKK', pilotId: 1001, departedAt: at(0), arrivedAt: at(2) })]);
      h.clock.now = at(3.5); // 15:30: would have been in time for 16:00
      assert.equal(await run(), 0, 'leg 1 is flown, so only leg 2 is left: it takes an hour, so 18:00, and it is not time yet');
      h.clock.now = at(5.5);
      assert.equal(await run(), 2);
      assert.ok(sent.every((s) => s.content.includes(`**${ts(at(6), 't')}**`)));
      assert.ok(sent.every((s) => !s.content.includes('EGLL')), 'and only the leg still to fly is mentioned');
    });

    it('does not warn the pilot of a leg that is flown about a leg that is not theirs', async () => {
      h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC', { availableFrom: at(-2), deadline: at(7) })]);
      h.jobs.reserve(view('m').job.id, [1], USER_A);
      h.jobs.reserve(view('m').job.id, [2], USER_C);
      h.store.updatePanel(pid(), { fshubAirlineId: 8123, fshubAirlineName: 'Test Air' });
      h.store.upsertFshubFlights(pid(), [fl({ dep: 'EGLL', arr: 'EGKK', departedAt: at(0), arrivedAt: at(2) })]);
      h.clock.now = at(5.7); // leg 2 (an hour, down by 19:00) is due at 18:00
      assert.equal(await run(), 1);
      assert.equal(sent[0]!.to, USER_C.discordId, 'Carol, who has the leg left, and not Alice, whose leg is flown');
    });

    it('leaves out a leg in the middle that is flown when working out the time left', async () => {
      durations.set('EGCC-EGPH', learned(90));
      h.jobs.sync(pid(), [sj('m', 'EGLL-EGKK-EGCC-EGPH', { availableFrom: at(-2), deadline: at(7) })]);
      for (const leg of [1, 2, 3]) h.jobs.reserve(view('m').job.id, [leg], leg === 2 ? USER_C : USER_A);
      h.store.updatePanel(pid(), { fshubAirlineId: 8123, fshubAirlineName: 'Test Air' });
      h.store.upsertFshubFlights(pid(), [fl({ dep: 'EGKK', arr: 'EGCC', departedAt: at(0), arrivedAt: at(1) })]); // leg 2, flown
      // Legs 1 and 3 are left: 2 h and 1 h 30 min, so the latest take-off is 15:30; counting the flown hour as well it would be 14:30.
      h.clock.now = at(3.1);
      assert.equal(await run(), 1);
      assert.equal(sent[0]!.to, USER_A.discordId);
      assert.ok(sent[0]!.content.includes(`**${ts(at(3.5), 't')}**`), 'a take-off at 15:30');
      assert.ok(!sent[0]!.content.includes('EGKK → EGCC'), 'the flown leg is not listed');
    });

    it('is none when every leg is flown', async () => {
      taken();
      h.store.updatePanel(pid(), { fshubAirlineId: 8123, fshubAirlineName: 'Test Air' });
      h.store.upsertFshubFlights(pid(), [fl({ dep: 'EGLL', arr: 'EGKK', pilotId: 1001, departedAt: at(0), arrivedAt: at(2) })]);
      h.clock.now = at(4.5);
      assert.equal(await run(), 0);
    });
  });

  describe('what it says', () => {
    it('gives the flight, when to take off, when it must be down, the time used and where it came from', async () => {
      taken();
      h.clock.now = at(4.5);
      await run();
      const m = to(USER_A)[0]!.content;
      assert.ok(m.startsWith('⏰ **Test Air**: **TST-001** (EGLL → EGKK): to land inside its window you need to take off by '));
      assert.ok(m.includes(`**${ts(at(5), 't')}** (${ts(at(5), 'R')})`));
      assert.ok(m.includes(`It has to be down by ${ts(at(7), 'f')}.`));
      assert.ok(m.includes("Flight time used: **2 h**, the middle time of the 6 flights of this route by your airline's pilots on FsHub, in the A320."));
      assert.match(m, /If you have already taken off, ignore it: I only see a flight once FsHub shows it landed\./);
    });

    it('says a time is an estimate from the distance, and what it assumed', async () => {
      taken();
      durations.set('EGLL-EGKK', distanceTime(500, 'A320')); // 92 minutes: the latest take-off is 17:28
      h.clock.now = at(5.1);
      await run();
      assert.match(to(USER_A)[0]!.content, /Flight time used: \*\*\d+ h( \d+ min)?\*\*, estimated from the 500 nm between the airports \(plus 5% for the route\) at the typical speed of a narrowbody airliner \(440 kt\)/);
    });

    it('lists the legs of a longer flight with their sources, and says the time on the ground is not counted', async () => {
      taken({}, 'EGLL-EGKK-EGCC');
      durations.set('EGKK-EGCC', distanceTime(200, 'A320')); // 49 minutes: with the 2 hours, the latest take-off is 16:11
      h.clock.now = at(3.9);
      await run();
      const m = to(USER_A)[0]!.content;
      assert.match(m, /\(EGLL → EGKK → EGCC\)/);
      assert.match(m, /Flight times used:\n• EGLL → EGKK: \*\*2 h\*\*, the middle time of the 6 flights/);
      assert.match(m, /\n• EGKK → EGCC: \*\*\d+ min\*\*, estimated from the 200 nm/);
      assert.match(m, /\nTogether \*\*\d+ h( \d+ min)?\*\*, not counting time on the ground between legs\.$/m);
    });

    it('does not let an airline\'s name make mentions or markdown', async () => {
      h.store.updatePanel(pid(), {});
      const panel = { ...h.store.getPanel(pid())!, airlineName: '@everyone *Air*' };
      taken();
      const plan = (await svc.plan(panel, view('a'), 1, at(4.5)))!;
      assert.ok(!pilotWarning(panel, plan).includes('@everyone'));
      assert.ok(!backupWarning(panel, plan, []).includes('@everyone'));
    });
  });

  describe('when it cannot be worked out', () => {
    it('says nothing rather than guess', async () => {
      taken();
      durations.set('EGLL-EGKK', null);
      h.clock.now = at(4.5);
      assert.equal(await run(), 0);
      assert.deepEqual(sent, []);
    });

    it('says nothing for a flight when any one of its legs has no time', async () => {
      taken({}, 'EGLL-EGKK-EGCC');
      durations.set('EGKK-EGCC', null);
      h.clock.now = at(4.6); // the first leg alone (2 h, down by 19:00) would be due at 17:00, so only the missing time holds the warning back
      assert.equal(await run(), 0);
    });

    it('warns once the time can be worked out', async () => {
      taken();
      durations.set('EGLL-EGKK', null);
      h.clock.now = at(4.5);
      await run();
      durations.set('EGLL-EGKK', learned(120));
      h.clock.advance(5 * MIN);
      assert.equal(await run(), 2);
    });
  });

  describe('when a message does not get through', () => {
    it('is not counted as sent, is tried again after ten minutes, and then only once', async () => {
      taken();
      deliverable = false;
      h.clock.now = at(4.5);
      assert.equal(await run(), 0);
      assert.equal(sent.length, 2, 'tried');
      h.clock.advance(5 * MIN);
      await run();
      assert.equal(sent.length, 2, 'not hammered');
      deliverable = true;
      h.clock.advance(6 * MIN);
      assert.equal(await run(), 2);
      assert.equal(sent.length, 4);
      h.clock.advance(11 * MIN);
      await run();
      assert.equal(sent.length, 4, 'and not again');
    });

    it('does not stop the others when one send throws', async () => {
      taken();
      let first = true;
      svc = new DepartureWarnings(
        h.store,
        h.jobs,
        { forLeg: async () => learned(120) },
        async (id, content) => {
          if (first) {
            first = false;
            throw new Error('Discord is unwell');
          }
          sent.push({ to: id, content });
          return true;
        },
        { now: () => h.clock.now },
      );
      h.clock.now = at(4.5);
      assert.equal(await svc.run(), 1);
    });

    it('gives up quietly once the latest take-off has passed', async () => {
      taken();
      deliverable = false;
      h.clock.now = at(4.9);
      await run();
      h.clock.now = at(5.1);
      deliverable = true;
      assert.equal(await run(), 0);
    });
  });
});

/* ------------------------------------------------------------------ all of it together */

describe('the warning, through the bot', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const at = (hours: number) => T0 + hours * HOUR;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('privately messages the pilot and the backup, from the airline\'s own flights, and nobody in the channel', async () => {
    // Heathrow to Gatwick in 40 minutes, seen three times on the airline's FsHub.
    h.store.upsertFshubFlights(pid(), [1, 2, 3].map((i) => fl({ departedAt: at(-i * 24), arrivedAt: at(-i * 24) + 40 * MIN })));
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK', { availableFrom: at(-2), deadline: at(7) })]);
    const job = h.jobs.open(pid())[0]!.job;
    h.jobs.reserve(job.id, [1], USER_A);
    h.jobs.addBackup(job.id, USER_B);
    const airports = new AirportDirectory(h.store, { fetchFn: async () => new Response(CSV), now: () => h.clock.now });
    const svc = new DepartureWarnings(h.store, h.jobs, new FlightTimes(h.store, airports), (id, c) => d.notifier.dm(id, c), { now: () => h.clock.now });
    h.clock.now = at(6.2); // 18:12: the latest take-off is 18:20
    assert.equal(await svc.run(), 2);
    assert.equal(alice.dms.length, 1);
    assert.equal(bob.dms.length, 1);
    assert.match(alice.dms[0].content, /need to take off by \*\*<t:\d+:t>\*\*/);
    assert.ok(alice.dms[0].content.includes(`**${ts(at(7) - 40 * MIN, 't')}**`), 'down by 19:00 less 40 minutes');
    assert.match(alice.dms[0].content, /Flight time used: \*\*40 min\*\*, the middle time of the 3 flights of this route by your airline's pilots on FsHub/);
    assert.deepEqual(alice.dms[0].allowedMentions, { parse: [] }, 'no pings');
  });

  it('works from the airports\' positions when no flight of the route has been seen', async () => {
    h.jobs.sync(pid(), [sj('a', 'KORD-KLAX', { availableFrom: at(-2), deadline: at(7) })]);
    const job = h.jobs.open(pid())[0]!.job;
    h.jobs.reserve(job.id, [1], USER_A);
    let downloads = 0;
    const airports = new AirportDirectory(h.store, {
      fetchFn: async () => {
        downloads++;
        return new Response(CSV);
      },
      now: () => h.clock.now,
    });
    const svc = new DepartureWarnings(h.store, h.jobs, new FlightTimes(h.store, airports), (id, c) => d.notifier.dm(id, c), { now: () => h.clock.now });
    h.clock.now = at(2.8); // a flight of about 4 hours that must be down by 19:00 leaves by about 15:00
    assert.equal(await svc.run(), 1);
    assert.match(alice.dms[0].content, /estimated from the 1,5\d\d nm between the airports/);
    assert.equal(downloads, 1);
    await svc.run();
    assert.equal(downloads, 1);
  });

  it('is not counted as sent when the person has direct messages closed, and a stranger is not an error', async () => {
    alice.failDms = true;
    assert.equal(await d.notifier.dm(USER_A.discordId, 'hello'), false);
    assert.equal(await d.notifier.dm('999999999999999999', 'hello'), false);
    alice.failDms = false;
    assert.equal(await d.notifier.dm(USER_A.discordId, 'hello'), true);
    assert.equal(alice.dms.at(-1).content, 'hello');
  });

  it('cuts a message to what Discord allows', async () => {
    await d.notifier.dm(USER_A.discordId, 'x'.repeat(5000));
    assert.ok(alice.dms[0].content.length <= 2000);
  });
});

/* ------------------------------------------------------------------ the scheduler */

describe('the scheduler and the warnings', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(() => h.close());

  it('runs them in the lane after the FsHub work, so the main pass is never held up', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = new Scheduler(h.jobs, d.refresher, {
      reminders: { run: async () => (calls.push('reminders'), 0) },
      fshub: { run: async () => void (calls.push('fshub start'), await gate, calls.push('fshub end')) },
      autoComplete: { run: async () => void calls.push('auto-complete') },
      departures: { run: async () => void calls.push('departures') },
    });
    await s.tick();
    assert.deepEqual(calls, ['reminders', 'fshub start']);
    release();
    await s.idle();
    assert.deepEqual(calls, ['reminders', 'fshub start', 'fshub end', 'auto-complete', 'departures']);
  });

  it('runs them even with no FsHub at all', async () => {
    let ran = 0;
    const s = new Scheduler(h.jobs, d.refresher, { departures: { run: async () => void ran++ } });
    await s.tick();
    await s.idle();
    assert.equal(ran, 1);
  });

  it('keeps going when they fail', async () => {
    const s = new Scheduler(h.jobs, d.refresher, { departures: { run: async () => Promise.reject(new Error('boom')) } });
    await assert.doesNotReject(s.tick());
    await assert.doesNotReject(s.idle());
  });
});

/* ------------------------------------------------------------------ /setup depart-warning */

describe('/setup depart-warning', () => {
  let h: Harness;
  let d: DiscordHarness;
  const pid = () => h.panel.id;
  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'depart-warning', admin: true, ...o });
    await setup.execute(d.ctx, f.i);
    await settle(40);
    return String(f.calls.edits.at(-1)?.content ?? '');
  };

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is minutes from 5 to 180, a mode, and an optional panel, with a description Discord accepts', () => {
    const sub = (setup.data.toJSON().options ?? []).find((o) => o.name === 'depart-warning') as unknown as { description: string; options: Array<{ name: string; min_value?: number; max_value?: number; required?: boolean; choices?: Array<{ value: string }> }> };
    assert.ok(sub && sub.description.length <= 100);
    const minutes = sub.options.find((o) => o.name === 'minutes')!;
    assert.deepEqual([minutes.min_value, minutes.max_value, minutes.required ?? false], [DEPART_WARNING_MIN_MINUTES, DEPART_WARNING_MAX_MINUTES, false]);
    assert.deepEqual(sub.options.find((o) => o.name === 'mode')!.choices!.map((c) => c.value), ['on', 'off']);
    assert.ok(sub.options.some((o) => o.name === 'airline'));
  });

  it('keeps the whole command inside what Discord allows', () => {
    const json = setup.data.toJSON();
    assert.ok((json.options ?? []).length <= 25, 'at most 25 subcommands');
    // Discord counts the name, description and value of the command, every subcommand, option and choice, and allows 8000 in all.
    const weigh = (o: any): number => (o.name?.length ?? 0) + (o.description?.length ?? 0) + (typeof o.value === 'string' ? o.value.length : 0) + [...(o.options ?? []), ...(o.choices ?? [])].reduce((n: number, c: any) => n + weigh(c), 0);
    assert.ok(weigh(json) < 8000, `command is ${weigh(json)} characters`);
  });

  it('shows the setting, which is on at 30 minutes, and says what the warning does', async () => {
    const reply = await run();
    assert.match(reply, /For \*\*Test Air\*\*, a pilot who holds a flight, and its backup pilot, gets a private message \*\*30 minutes\*\* before the latest time they could take off and still land inside the flight's window/);
    assert.match(reply, /FsHub flights of that route when I have seen some, and otherwise it is estimated from the distance between the airports; the message says which/);
    assert.doesNotMatch(reply, /^Done/);
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 30);
  });

  it('sets the minutes', async () => {
    const reply = await run({ options: { minutes: 45 } });
    assert.match(reply, /^Done\. .*\*\*45 minutes\*\*/);
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 45);
    assert.doesNotMatch(await run({ options: { minutes: 45 } }), /^Done/, 'nothing to say was done when nothing changed');
  });

  it('switches it off, says so, and switches it back on at 30 minutes, or at the minutes given', async () => {
    assert.match(await run({ options: { mode: 'off' } }), /^Done\. The late-departure warning is \*\*off\*\* for \*\*Test Air\*\*/);
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 0);
    assert.match(await run(), /is \*\*off\*\*/, 'and the setting shows as off');
    assert.match(await run({ options: { mode: 'on' } }), /^Done\. .*\*\*30 minutes\*\*/);
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 30);
    await run({ options: { mode: 'off' } });
    assert.match(await run({ options: { mode: 'on', minutes: 60 } }), /\*\*60 minutes\*\*/);
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 60);
  });

  it('keeps the minutes when told on while it is already on', async () => {
    await run({ options: { minutes: 75 } });
    await run({ options: { mode: 'on' } });
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 75);
  });

  it('refuses minutes with off, and minutes outside the range', async () => {
    await assert.rejects(run({ options: { minutes: 30, mode: 'off' } }), (e: unknown) => e instanceof UserError && /not both/.test(e.message));
    for (const bad of [4, 181, 0, -5]) {
      await assert.rejects(run({ options: { minutes: bad } }), (e: unknown) => e instanceof UserError && /from 5 to 180/.test(e.message), String(bad));
    }
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 30, 'nothing changed');
  });

  it('is for admins only', async () => {
    await assert.rejects(run({ admin: false, options: { minutes: 60 } }), (e: unknown) => e instanceof UserError && /Manage Server/.test(e.message));
    assert.equal(h.store.getPanel(pid())!.departWarningMinutes, 30);
  });
});
