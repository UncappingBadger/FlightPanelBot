import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MIGRATIONS } from '../src/db/db.js';
import { Store, type FlownFlight, type JobView } from '../src/db/store.js';
import { completedCard, flightFacts, fshubFlightLink, renderPanelParts } from '../src/discord/ui.js';
import { componentHandlers, commands } from '../src/discord/commands/index.js';
import { FsHubClient, FsHubError, parseFlightPage, type FsHubFlight } from '../src/fshub/client.js';
import { confirmationsFor, confirmationsSignature, landingWindow, sameAircraft, WINDOW_GRACE_MS } from '../src/services/flightMatch.js';
import { FLIGHT_KEEP_MS, FLIGHT_SYNC_MS, FSHUB_SYNC_MS, FsHubSync, RESCAN_MS } from '../src/services/fshubSync.js';
import { CHANNEL, HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeFsHub, FakeUser, fakeComponent, fakeInteraction, makeDiscordHarness, settle, type DiscordHarness, messageText } from './discord-helpers.js';

/* Everything below is made up. The pilots, airlines and flights are not real. */

const setup = commands.find((c) => c.data.name === 'setup')!;
const AIRLINE_ID = 8123;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------------ reading what FsHub sends */

const rawFlight = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  user: { id: 500, name: 'Ann Pilot' },
  aircraft: { icao: 'B738', icao_name: 'Boeing 737-800', name: 'Some Livery', type: 'x', user_conf: { tail: '', icao: '' } },
  departure: { icao: 'EGLL', time: '2026-11-11T10:00:00.000000Z' },
  arrival: { icao: 'EGKK', time: '2026-11-11T11:00:00.000000Z' },
  schedule_status: 'ON-TIME',
  ...over,
});

describe('reading a page of flights', () => {
  it('keeps what matching needs', () => {
    const page = parseFlightPage([rawFlight(7)]);
    assert.deepEqual(page.flights, [
      {
        id: 7,
        pilotId: 500,
        pilotName: 'Ann Pilot',
        dep: 'EGLL',
        arr: 'EGKK',
        departedAt: Date.UTC(2026, 10, 11, 10),
        arrivedAt: Date.UTC(2026, 10, 11, 11),
        aircraftIcao: 'B738',
        aircraftName: 'Boeing 737-800',
        scheduleStatus: 'ON-TIME',
      },
    ]);
    assert.deepEqual([page.count, page.lastId, page.firstAt, page.lastAt], [1, 7, Date.UTC(2026, 10, 11, 11), Date.UTC(2026, 10, 11, 11)]);
  });

  it('leaves out a flight it cannot match, but still counts it and still knows where the page sits in time', () => {
    const page = parseFlightPage([
      rawFlight(10, { arrival: { icao: 'EGKK', time: null } }), // never landed on record: only its take-off time is known
      rawFlight(11),
      rawFlight(12, { departure: null, arrival: { icao: 'EGKK', time: '2026-11-11T13:00:00.000000Z' } }),
      rawFlight(13, { departure: { icao: 'TOOLONG', time: '2026-11-11T09:00:00.000000Z' } }),
      rawFlight(14, { user: null }),
      'junk',
      null,
    ]);
    assert.deepEqual(page.flights.map((f) => f.id), [11]);
    assert.equal(page.count, 7, 'every entry counts towards a full page');
    assert.equal(page.lastId, 14, 'the next page starts after the highest ID, usable or not');
    assert.equal(page.firstAt, Date.UTC(2026, 10, 11, 10), "falls back to the take-off time of the first entry");
  });

  it('tidies codes and status words, and caps long names', () => {
    const [f] = parseFlightPage([
      rawFlight(1, {
        departure: { icao: ' egll ', time: '2026-11-11T10:00:00Z' },
        aircraft: { icao: 'b738', icao_name: `  ${'Very '.repeat(40)}\nLong \u0000 name ` },
        schedule_status: 'late',
      }),
    ]).flights;
    assert.equal(f!.dep, 'EGLL');
    assert.equal(f!.aircraftIcao, 'B738');
    assert.equal(f!.scheduleStatus, 'LATE');
    assert.ok(f!.aircraftName!.length <= 60 && !/[\n\u0000]/.test(f!.aircraftName!));
    for (const [word, want] of [['DELAYED', 'DELAYED'], ['mystery', null], [null, null], ['', null]] as const) {
      assert.equal(parseFlightPage([rawFlight(2, { schedule_status: word })]).flights[0]!.scheduleStatus, want, String(word));
    }
  });

  it('is an empty page for nothing', () => {
    assert.deepEqual(parseFlightPage([]), { flights: [], count: 0, lastId: null, firstAt: null, lastAt: null });
  });
});

describe('asking FsHub for an airline\'s flights', () => {
  const make = (answer: (url: URL) => Response) => {
    const urls: URL[] = [];
    const fetchFn = (async (u: string) => {
      const url = new URL(String(u));
      urls.push(url);
      return answer(url);
    }) as unknown as typeof fetch;
    return { urls, client: new FsHubClient({ token: 'tok-0123456789abcdefghijkl', fetchFn }) };
  };
  const okPage = () => new Response(JSON.stringify({ data: [rawFlight(5)], meta: { cursor: { current: 0, prev: 0, next: 5, count: 1 } } }));

  it('asks for the flights after a cursor, a page at a time, and never for more than FsHub gives', async () => {
    const { client, urls } = make(okPage);
    await client.airlineFlights(9, 0, 100);
    await client.airlineFlights(9, 4904151, 500);
    await client.airlineFlights(9, 12, 0);
    assert.deepEqual(
      urls.map((u) => [u.pathname, u.searchParams.get('limit'), u.searchParams.get('cursor')]),
      [
        ['/api/v3/airline/9/flight', '100', null],
        ['/api/v3/airline/9/flight', '100', '4904151'],
        ['/api/v3/airline/9/flight', '1', '12'],
      ],
    );
  });

  it('is an empty page when FsHub says there is nothing after the cursor', async () => {
    const { client } = make(() => new Response(JSON.stringify({ error: true, message: 'No records found' }), { status: 404 }));
    assert.deepEqual(await client.airlineFlights(9, 99999999, 1), { flights: [], count: 0, lastId: null, firstAt: null, lastAt: null });
    const none = make(() => new Response(null, { status: 204 }));
    assert.equal((await none.client.airlineFlights(9, 0, 1)).count, 0);
  });

  it('refuses a cursor or airline that is not a whole number, before it can become part of an address', async () => {
    const { client, urls } = make(okPage);
    for (const bad of [-1, 1.5, Number.NaN]) await assert.rejects(client.airlineFlights(9, bad, 1), /Not a FsHub cursor/);
    await assert.rejects(client.airlineFlights(0, 0, 1), /Not a FsHub ID/);
    assert.equal(urls.length, 0);
  });

  it('says plainly when the token may not see the airline\'s flights, and when the answer makes no sense', async () => {
    const denied = make(() => new Response(JSON.stringify({ error: true, message: 'Only airline members or premium accounts can access this endpoint.' }), { status: 401 }));
    await assert.rejects(denied.client.airlineFlights(9, 0, 1), (e: unknown) => e instanceof FsHubError && e.kind === 'no-access');
    const weird = make(() => new Response(JSON.stringify({ data: 'nope' })));
    await assert.rejects(weird.client.airlineFlights(9, 0, 1), (e: unknown) => e instanceof FsHubError && e.kind === 'bad-response');
  });
});

/* ------------------------------------------------------------------ what the store keeps */

let seq = 7000;
/** A flight FsHub recorded: by default Ann (FsHub 500) flying EGLL to EGKK in the first hours of the test day. */
const fl = (over: Partial<FlownFlight> = {}): FlownFlight => ({
  flightId: ++seq,
  pilotId: 500,
  pilotName: 'Ann Pilot',
  dep: 'EGLL',
  arr: 'EGKK',
  departedAt: T0 + HOUR,
  arrivedAt: T0 + 2 * HOUR,
  aircraftIcao: 'A320',
  aircraftName: 'Airbus A320',
  scheduleStatus: 'ON-TIME',
  ...over,
});

describe('the flights the store keeps', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('keeps flights per panel, counts the new ones, and brings a known one up to date', () => {
    const a = fl();
    assert.equal(h.store.upsertFshubFlights(h.panel.id, [a, fl({ dep: 'EGKK', arr: 'EGLL' })]), 2);
    assert.equal(h.store.upsertFshubFlights(h.panel.id, [{ ...a, scheduleStatus: 'DELAYED' }]), 0, 'not new');
    assert.equal(h.store.countFshubFlights(h.panel.id), 2);
    assert.equal(h.store.listFshubFlights(h.panel.id, 'EGLL', 'EGKK', T0, T0 + 5 * HOUR)[0]!.scheduleStatus, 'DELAYED');
    const other = h.store.createPanel({ guildId: '9', name: 'Other Air', prefix: 'OTH', channelId: '8', now: T0 });
    assert.equal(h.store.countFshubFlights(other.id), 0, 'another panel does not see them');
  });

  it('lists the flights on one route that landed inside a window, earliest first', () => {
    const early = fl({ arrivedAt: T0 + HOUR });
    const late = fl({ arrivedAt: T0 + 3 * HOUR });
    h.store.upsertFshubFlights(h.panel.id, [late, early, fl({ arrivedAt: T0 + 9 * HOUR }), fl({ arr: 'EGCC' })]);
    assert.deepEqual(h.store.listFshubFlights(h.panel.id, 'EGLL', 'EGKK', T0, T0 + 4 * HOUR).map((f) => f.flightId), [early.flightId, late.flightId]);
    assert.deepEqual(h.store.listFshubFlights(h.panel.id, 'EGKK', 'EGLL', T0, T0 + 4 * HOUR), [], 'the other direction is another route');
  });

  it('forgets old flights, and everything when asked, and goes with its panel', () => {
    h.store.upsertFshubFlights(h.panel.id, [fl({ arrivedAt: T0 - 9 * DAY }), fl({ arrivedAt: T0 })]);
    assert.equal(h.store.pruneFshubFlights(h.panel.id, T0 - 7 * DAY), 1);
    h.store.updatePanel(h.panel.id, { fshubFlightCursor: 4_900_000, fshubFlightsAt: T0, fshubFlightsNote: 'old trouble' });
    h.store.clearFshubFlights(h.panel.id);
    const p = h.store.getPanel(h.panel.id)!;
    assert.deepEqual([h.store.countFshubFlights(h.panel.id), p.fshubFlightCursor, p.fshubFlightsAt, p.fshubFlightsNote], [0, 0, null, null]);
    h.store.upsertFshubFlights(h.panel.id, [fl()]);
    h.store.deletePanel(h.panel.id);
    assert.equal(h.store.countFshubFlights(h.panel.id), 0, 'deleted with the panel');
  });

  it('upgrades a v12 database: the flights table appears, existing panels start with confirming on', () => {
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < 12; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at, fshub_airline_id) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1, 8123)`).run();
    assert.ok(MIGRATIONS.length >= 13);
    old.exec(MIGRATIONS[12] as string);
    const store = new Store(old);
    const panel = store.listAllPanels()[0]!;
    assert.deepEqual([panel.fshubConfirm, panel.fshubFlightCursor, panel.fshubFlightsAt, panel.fshubFlightsNote], [true, 0, null, null]);
    assert.equal(store.upsertFshubFlights(panel.id, [fl()]), 1);
  });
});

/* ------------------------------------------------------------------ matching */

describe('matching FsHub flights to the panel\'s flights', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
  });
  afterEach(() => h.close());

  const panel = () => h.store.getPanel(h.panel.id)!;
  const keep = (...f: FlownFlight[]) => h.store.upsertFshubFlights(h.panel.id, f);
  /** A job with a window from T0 to T0 + 12 h unless said otherwise. */
  const jobs = (...specs: Array<[string, string, Record<string, unknown>?]>): JobView[] => {
    h.jobs.sync(h.panel.id, specs.map(([key, chain, over]) => sj(key, chain, { availableFrom: T0, deadline: T0 + 12 * HOUR, ...(over ?? {}) })));
    return h.jobs.open(h.panel.id);
  };
  const confirmed = (views: JobView[]) => confirmationsFor(h.store, panel(), views, T0 + 6 * HOUR);

  describe('the landing window', () => {
    it('is the job\'s own window, with an hour either side', () => {
      const [v] = jobs(['a', 'EGLL-EGKK']);
      assert.deepEqual(landingWindow(v!.job, T0), { from: T0 - WINDOW_GRACE_MS, to: T0 + 12 * HOUR + WINDOW_GRACE_MS });
    });

    it('copes with a job that has no start, no end, or neither', () => {
      const [noStart] = jobs(['a', 'EGLL-EGKK', { availableFrom: null }]);
      assert.equal(landingWindow(noStart!.job, T0).from, T0 + 12 * HOUR - 48 * HOUR - WINDOW_GRACE_MS);
      const [noEnd] = jobs(['b', 'EGLL-EGKK', { deadline: null }]);
      assert.deepEqual(landingWindow(noEnd!.job, T0 + 5 * HOUR), { from: T0 - WINDOW_GRACE_MS, to: T0 + 5 * HOUR + WINDOW_GRACE_MS });
      const [neither] = jobs(['c', 'EGLL-EGKK', { availableFrom: null, deadline: null }]);
      assert.deepEqual(landingWindow(neither!.job, T0 + 5 * HOUR), { from: T0 + 5 * HOUR - 48 * HOUR - WINDOW_GRACE_MS, to: T0 + 5 * HOUR + WINDOW_GRACE_MS });
    });
  });

  describe('a leg nobody with a known FsHub ID holds (a pilot named in the sheet)', () => {
    it('is confirmed by the one flight on its route inside its window', () => {
      const views = jobs(['a', 'EGLL-EGKK']);
      const f = fl({ arrivedAt: T0 + 3 * HOUR });
      keep(f, fl({ arr: 'EGCC' }), fl({ arrivedAt: T0 + 40 * HOUR }));
      assert.equal(confirmed(views).get(views[0]!.job.id)!.get(1)!.flightId, f.flightId);
    });

    it('is not confirmed when two flights could be it: nothing is claimed rather than something wrong', () => {
      const views = jobs(['a', 'EGLL-EGKK']);
      keep(fl(), fl({ pilotId: 501 }));
      assert.equal(confirmed(views).size, 0);
    });

    it('counts a landing up to an hour outside the window, and no more', () => {
      const views = jobs(['a', 'EGLL-EGKK']);
      const edge = fl({ arrivedAt: T0 - HOUR });
      keep(edge);
      assert.equal(confirmed(views).size, 1, 'exactly an hour early');
      h.store.clearFshubFlights(h.panel.id);
      keep(fl({ arrivedAt: T0 - HOUR - 1 }), fl({ arrivedAt: T0 + 13 * HOUR + 1, pilotId: 501 }));
      assert.equal(confirmed(views).size, 0);
    });

    it('is not confirmed by the same airports flown the other way, or by a flight to somewhere else', () => {
      const views = jobs(['a', 'EGLL-EGKK']);
      keep(fl({ dep: 'EGKK', arr: 'EGLL' }), fl({ dep: 'EGLL', arr: 'EGCC' }));
      assert.equal(confirmed(views).size, 0);
    });
  });

  describe('a leg held by someone whose FsHub ID the bot knows', () => {
    const reserveFor = (views: JobView[], who: typeof USER_A, fshubId: number | null) => {
      if (fshubId !== null) h.store.setPilotId(who.discordId, fshubId, T0);
      for (const v of views) h.jobs.reserve(v.job.id, [1], who);
      return h.jobs.open(h.panel.id);
    };

    it('is confirmed only by a flight that pilot flew, even when another pilot flew the route', () => {
      const views = reserveFor(jobs(['a', 'EGLL-EGKK']), USER_A, 500);
      keep(fl({ pilotId: 501 }));
      assert.equal(confirmed(views).size, 0, 'someone else flew it');
      const mine = fl({ pilotId: 500, arrivedAt: T0 + 4 * HOUR });
      keep(mine);
      assert.equal(confirmed(h.jobs.open(h.panel.id)).get(views[0]!.job.id)!.get(1)!.flightId, mine.flightId, 'two candidates, one of them hers');
    });

    it('takes their latest flight if they flew the route twice', () => {
      const views = reserveFor(jobs(['a', 'EGLL-EGKK']), USER_A, 500);
      const second = fl({ arrivedAt: T0 + 8 * HOUR });
      keep(fl({ arrivedAt: T0 + 2 * HOUR }), second);
      assert.equal(confirmed(views).get(views[0]!.job.id)!.get(1)!.flightId, second.flightId);
    });

    it('is treated like an unknown pilot when the bot does not know their FsHub ID', () => {
      const views = reserveFor(jobs(['a', 'EGLL-EGKK']), USER_A, null);
      keep(fl({ pilotId: 777 }));
      assert.equal(confirmed(views).size, 1, 'one candidate, so it counts');
      keep(fl({ pilotId: 778 }));
      assert.equal(confirmed(views).size, 0, 'two candidates, so it does not');
    });

    it('in strict mode (used when a pilot\'s own claim is acted on) is never confirmed by a flight when their FsHub ID is not known', () => {
      const views = reserveFor(jobs(['a', 'EGLL-EGKK']), USER_A, null);
      keep(fl({ pilotId: 777 }));
      assert.equal(confirmationsFor(h.store, panel(), views, T0 + 6 * HOUR).size, 1, 'shown, in the ordinary way');
      assert.equal(confirmationsFor(h.store, panel(), views, T0 + 6 * HOUR, { strict: true }).size, 0, 'but not enough to act on');
    });
  });

  it('lets a FsHub flight confirm at most one flight, the first listed getting it', () => {
    const views = jobs(['a', 'EGLL-EGKK'], ['b', 'EGLL-EGKK']);
    const f = fl();
    keep(f);
    const one = confirmed(views);
    assert.deepEqual([...one.keys()], [views[0]!.job.id], 'the first job claims it');
    keep(fl({ pilotId: 501 }));
    // Two flights, two jobs, but each job sees two candidates and neither can say which is its own: still nothing wrong claimed.
    assert.equal(confirmed(views).size, 0);
  });

  it('confirms a multi-leg flight leg by leg', () => {
    const views = jobs(['m', 'EGLL-EGKK-EGCC']);
    const first = fl({ dep: 'EGLL', arr: 'EGKK' });
    keep(first);
    const legs = confirmed(views).get(views[0]!.job.id)!;
    assert.deepEqual([...legs.keys()], [1]);
    keep(fl({ dep: 'EGKK', arr: 'EGCC', arrivedAt: T0 + 5 * HOUR }));
    assert.deepEqual([...confirmed(views).get(views[0]!.job.id)!.keys()], [1, 2]);
  });

  it('confirms nothing for a panel that is not linked, or has confirming switched off, or holds no flights', () => {
    const views = jobs(['a', 'EGLL-EGKK']);
    assert.equal(confirmed(views).size, 0, 'no flights kept yet');
    keep(fl());
    assert.equal(confirmed(views).size, 1);
    h.store.updatePanel(h.panel.id, { fshubConfirm: false });
    assert.equal(confirmed(views).size, 0);
    h.store.updatePanel(h.panel.id, { fshubConfirm: true, fshubAirlineId: null });
    assert.equal(confirmed(views).size, 0);
  });

  it('has a signature that changes only when what is confirmed does', () => {
    const views = jobs(['a', 'EGLL-EGKK']);
    const f = fl();
    keep(f);
    const before = confirmationsSignature(confirmed(views));
    assert.equal(confirmationsSignature(confirmed(views)), before);
    keep({ ...f, scheduleStatus: 'DELAYED' });
    assert.notEqual(confirmationsSignature(confirmed(views)), before);
    assert.equal(confirmationsSignature(new Map()), '');
  });

  describe('the aircraft', () => {
    it('is the same, different, or cannot be compared', () => {
      assert.equal(sameAircraft('A320', 'A320'), true);
      assert.equal(sameAircraft(' a320 ', 'A320'), true);
      assert.equal(sameAircraft('B737', 'B738'), false);
      assert.equal(sameAircraft('A20N', 'A320'), false);
      assert.equal(sameAircraft('A32', 'A320'), null, 'a schedule\'s abbreviation (a typo in the sheet) is not a mismatch');
      assert.equal(sameAircraft('Boeing 737-800', 'B738'), null, 'a type given in words');
      assert.equal(sameAircraft(null, 'B738'), null);
      assert.equal(sameAircraft('B738', null), null);
    });

    it('does not decide whether a flight matches: a different type was still flown', () => {
      const views = jobs(['a', 'EGLL-EGKK', { aircraft: 'B738' }]);
      keep(fl({ aircraftIcao: 'A320' }));
      assert.equal(confirmed(views).size, 1);
    });
  });
});

/* ------------------------------------------------------------------ what it looks like */

describe('how a confirmation reads', () => {
  const flight = fl({ arrivedAt: Date.UTC(2026, 10, 11, 14, 30), aircraftIcao: 'B738', aircraftName: 'Boeing 737-800' });
  const ts = Math.floor(flight.arrivedAt / 1000);

  it('names the aircraft, when it landed in each reader\'s own timezone, and how it went', () => {
    assert.equal(flightFacts(flight, null), `B738 (Boeing 737-800), landed <t:${ts}:t> · on time`);
    assert.match(flightFacts({ ...flight, scheduleStatus: 'DELAYED' }, null), /· delayed$/);
    assert.match(flightFacts({ ...flight, scheduleStatus: 'LATE' }, null), /· late$/);
    assert.equal(flightFacts({ ...flight, scheduleStatus: null }, null), `B738 (Boeing 737-800), landed <t:${ts}:t>`);
  });

  it('copes with FsHub having only part of the aircraft', () => {
    assert.match(flightFacts({ ...flight, aircraftName: null }, null), /^B738, landed/);
    assert.match(flightFacts({ ...flight, aircraftIcao: null }, null), /^Boeing 737-800, landed/);
    assert.match(flightFacts({ ...flight, aircraftIcao: null, aircraftName: null }, null), /^aircraft not recorded, landed/);
  });

  it('warns when the aircraft is not the one scheduled, but not when it is or cannot be told', () => {
    assert.match(flightFacts(flight, 'A320'), /· ⚠️ scheduled A320$/);
    assert.doesNotMatch(flightFacts(flight, 'B738'), /⚠️/);
    assert.doesNotMatch(flightFacts(flight, 'Boeing 737-800'), /⚠️/);
    assert.doesNotMatch(flightFacts({ ...flight, aircraftIcao: 'B738' }, 'B73'), /⚠️/);
  });

  it('shows a name from outside as plain text only', () => {
    const text = flightFacts({ ...flight, aircraftName: '**bold** @everyone <@123456789012345678> [x](https://evil.example)' }, null);
    assert.equal(/(^|[^\\])@everyone/.test(text), false);
    assert.equal(text.includes('<@123456789012345678>'), false);
    assert.equal(/(^|[^\\])\*\*bold/.test(text), false);
  });

  describe('on the completed list', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await makeHarness();
    });
    afterEach(() => h.close());
    const done = (chain: string, key = 'a') => {
      h.jobs.sync(h.panel.id, [sj(key, chain, { availableFrom: T0, deadline: T0 + 12 * HOUR, aircraft: 'B738' })]);
      const job = h.jobs.open(h.panel.id).find((v) => v.job.sourceKey === key)!;
      h.jobs.reserve(job.job.id, job.legs.map((l) => l.legNo), USER_A);
      return h.jobs.complete(job.job.id, USER_A.discordId);
    };
    const cardOf = (view: ReturnType<typeof done>, confirmed?: Map<number, FlownFlight>) => completedCard(view, confirmed).toJSON();
    const box = (c: ReturnType<typeof cardOf>, name: string) => c.fields?.find((f) => f.name === name)?.value;
    const link = (id: number, label = `#${id}`) => `[${label}](https://fshub.io/flight/${id}/report)`;

    it('adds what FsHub recorded to a one-leg flight, and leaves the card as it was without it', () => {
      const view = done('EGLL-EGKK');
      const plain = cardOf(view);
      assert.equal(plain.title, 'TST-001 · B738');
      assert.doesNotMatch(JSON.stringify(plain), /fshub\.io|LANDED/);
      assert.deepEqual(cardOf(view, new Map()), plain);

      const c = cardOf(view, new Map([[1, flight]]));
      assert.equal(c.title, 'TST-001 · B738 · on time');
      assert.equal(c.description, '## EGLL ✈ EGKK\n*Boeing 737-800*');
      assert.match(box(c, 'FLOWN BY')!, /^<@\d+>/);
      assert.equal(box(c, 'LANDED'), `<t:${ts}:t>`);
      assert.equal(box(c, 'FSHUB'), link(flight.flightId, `flight #${flight.flightId}`));
    });

    it('shows the aircraft FsHub recorded, and warns when it is not the one that was scheduled', () => {
      const view = done('EGLL-EGKK');
      const c = cardOf(view, new Map([[1, { ...flight, aircraftIcao: 'A320', aircraftName: 'Airbus A320' }]]));
      assert.equal(c.title, 'TST-001 · A320 · on time', 'what was flown, not what was scheduled');
      assert.equal(c.description, '## EGLL ✈ EGKK\n*Airbus A320*\n⚠️ scheduled B738');
    });

    it('says how it went against its schedule, in FsHub\'s own words, and nothing when FsHub has none', () => {
      const view = done('EGLL-EGKK');
      assert.equal(cardOf(view, new Map([[1, { ...flight, scheduleStatus: 'DELAYED' }]])).title, 'TST-001 · B738 · delayed');
      assert.equal(cardOf(view, new Map([[1, { ...flight, scheduleStatus: 'LATE' }]])).title, 'TST-001 · B738 · late');
      assert.equal(cardOf(view, new Map([[1, { ...flight, scheduleStatus: null }]])).title, 'TST-001 · B738');
    });

    it('says how many legs of a longer flight FsHub saw, with a link to each', () => {
      const view = done('EGLL-EGKK-EGCC', 'm');
      const second = { ...flight, flightId: flight.flightId + 1, aircraftIcao: 'A320' };
      const one = cardOf(view, new Map([[1, flight]]));
      assert.equal(one.title, 'TST-001 · 2 legs · B738');
      assert.equal(box(one, 'FSHUB'), `1 of 2 legs\n${link(flight.flightId)}`);
      assert.equal(box(one, 'LANDED'), undefined, 'no single landing time for several legs');
      const both = cardOf(view, new Map([[1, flight], [2, second]]));
      assert.equal(box(both, 'FSHUB'), `2 of 2 legs\n${link(flight.flightId)}, ${link(second.flightId)}`);
    });

    it('links to FsHub\'s own report for the flight, built from its number alone', () => {
      assert.equal(fshubFlightLink(1796723), '[#1796723](https://fshub.io/flight/1796723/report)');
      assert.equal(fshubFlightLink(1796723, 'flight #1796723'), '[flight #1796723](https://fshub.io/flight/1796723/report)');
      for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) assert.equal(fshubFlightLink(bad), '', `${bad} makes no link`);
    });

    it('shows a name from FsHub as plain text only', () => {
      const view = done('EGLL-EGKK');
      const text = JSON.stringify(cardOf(view, new Map([[1, { ...flight, aircraftName: '**bold** @everyone <@123456789012345678> [x](https://evil.example)' }]])));
      assert.doesNotMatch(text, /(^|[^\\])@everyone/);
      assert.doesNotMatch(text, /<@123456789012345678>/);
      assert.doesNotMatch(text, /\[x\]\(https:\/\/evil\.example\)/);
    });

    it('gives each flight on the completed flights panel its own confirmation', () => {
      const a = done('EGLL-EGKK', 'a');
      const b = done('EGKK-EGCC', 'b');
      const parts = renderPanelParts(h.panel, [], T0, [a, b], new Map([[a.job.id, new Map([[1, flight]])]]));
      const cards = parts.completed.flat().map((e) => e.toJSON());
      const cardFor = (code: string) => cards.find((c) => c.title?.startsWith(code))!;
      assert.ok(cardFor(a.job.code).fields!.some((f) => f.name === 'FSHUB'));
      assert.ok(!cardFor(b.job.code).fields!.some((f) => f.name === 'FSHUB'));
    });
  });
});

/* ------------------------------------------------------------------ reading the airline's flights */

describe('reading the airline\'s flights into the bot', () => {
  let h: Harness;
  let fshub: FakeFsHub;
  let sync: FsHubSync;
  let scheduled: number[];
  let now: number;

  /** A flight FsHub lists: `hoursAgo` is when it landed; its ID grows with time, as FsHub's do. */
  const listed = (hoursAgo: number, over: Partial<FsHubFlight> = {}): FsHubFlight => {
    const arrivedAt = now - hoursAgo * HOUR;
    return {
      id: 4_000_000 + Math.round((arrivedAt - (now - 400 * DAY)) / 60_000),
      pilotId: 500,
      pilotName: 'Ann Pilot',
      dep: 'EGLL',
      arr: 'EGKK',
      departedAt: arrivedAt - HOUR,
      arrivedAt,
      aircraftIcao: 'A320',
      aircraftName: 'Airbus A320',
      scheduleStatus: 'ON-TIME',
      ...over,
    };
  };
  const serve = (...f: FsHubFlight[]) => fshub.flights.set(AIRLINE_ID, [...(fshub.flights.get(AIRLINE_ID) ?? []), ...f]);
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    fshub = new FakeFsHub();
    scheduled = [];
    now = T0 + 20 * DAY;
    h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    sync = new FsHubSync(h.store, fshub, { schedule: (id) => void scheduled.push(id) }, { now: () => now, completed: (id) => h.jobs.completed(id) });
  });
  afterEach(() => h.close());

  describe('the first read', () => {
    it('finds the recent flights by searching, not by reading the airline\'s whole history', async () => {
      // A long history (hundreds of days) and a recent stretch of three flights a day.
      for (let d = 400; d > 10; d -= 2) serve(listed(d * 24));
      for (let d = 10; d >= 0; d--) for (let k = 0; k < 3; k++) serve(listed(d * 24 + k * 5, { pilotId: 500 + k }));
      const r = await sync.syncFlights(panel());
      assert.equal(r.ok, true);
      const recent = (fshub.flights.get(AIRLINE_ID) ?? []).filter((f) => f.arrivedAt >= now - FLIGHT_KEEP_MS);
      assert.equal(r.kept, recent.length, 'every flight of the last week is kept, and no old one');
      assert.ok(fshub.flightCalls.length <= 30, `${fshub.flightCalls.length} requests, nowhere near the ${Math.ceil(((fshub.flights.get(AIRLINE_ID) ?? []).length) / 100)} pages of the whole history`);
      assert.equal(fshub.flightCalls.filter((c) => c.limit === 100).length, 1, 'one real page after the search');
      assert.equal(panel().fshubFlightsAt, now);
      assert.equal(panel().fshubFlightsNote, null);
    });

    it('reads from the very beginning for an airline whose first flight is recent, and for one with no flights at all', async () => {
      serve(listed(30), listed(2));
      assert.equal((await sync.syncFlights(panel())).kept, 2);
      assert.equal(fshub.flightCalls[0]!.cursor, 0);
      h.store.clearFshubFlights(h.panel.id);
      const empty = new FakeFsHub();
      const quiet = new FsHubSync(h.store, empty, { schedule() {} }, { now: () => now });
      const r = await quiet.syncFlights(panel());
      assert.deepEqual([r.ok, r.kept], [true, 0]);
    });

    it('an airline whose flights are all old keeps none, and still finishes', async () => {
      for (let d = 400; d > 100; d -= 3) serve(listed(d * 24));
      const r = await sync.syncFlights(panel());
      assert.deepEqual([r.ok, r.kept], [true, 0]);
      assert.ok(fshub.flightCalls.length <= 30);
    });

    it('is not saved halfway: a failure during the search leaves nothing behind to be mistaken for progress', async () => {
      for (let d = 400; d > 10; d -= 2) serve(listed(d * 24));
      serve(listed(5));
      fshub.flightError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
      const r = await sync.syncFlights(panel());
      assert.equal(r.ok, false);
      assert.equal(panel().fshubFlightCursor, 0);
      assert.equal(panel().fshubFlightsNote, "I couldn't reach FsHub right now.");
      fshub.flightError = null;
      assert.equal((await sync.syncFlights(panel())).kept, 1, 'and the next try works');
      assert.equal(panel().fshubFlightsNote, null);
    });
  });

  describe('after that', () => {
    it('reads on from where it got to, and a new flight appears', async () => {
      serve(listed(40), listed(30), listed(3));
      await sync.syncFlights(panel());
      const cursor = panel().fshubFlightCursor;
      assert.ok(cursor > 0);
      now += 10 * 60_000;
      const added = listed(0.1, { pilotId: 501 });
      serve(added);
      const r = await sync.syncFlights(panel());
      assert.equal(r.added, 1);
      assert.equal(h.store.countFshubFlights(h.panel.id), 4);
      assert.equal(fshub.flightCalls.at(-1)!.cursor, cursor, 'it asked from the saved place, not from the start');
      assert.ok(cursor < added.id, 'which is before the new flight');
    });

    it('never moves its place past anything that could still turn up: a long flight can be listed after a shorter one that started later', async () => {
      // The long flight took off first (lower ID) and lands at "now"; a short one took off later, landed earlier, and is already listed.
      const shortFlight = listed(2, { id: 5_000_100, pilotId: 501, departedAt: now - 3 * HOUR });
      serve(listed(60), shortFlight);
      await sync.syncFlights(panel());
      const longFlight = listed(0.2, { id: 5_000_050, pilotId: 502, departedAt: now - 9 * HOUR });
      serve(longFlight);
      now += 6 * 60_000;
      const r = await sync.syncFlights(panel());
      assert.equal(r.added, 1, 'the late-listed flight with the lower number is still found');
      assert.ok(h.store.listFshubFlights(h.panel.id, 'EGLL', 'EGKK', 0, now + HOUR).some((f) => f.flightId === longFlight.id));
    });

    it('moves its place on as flights grow old, so it does not re-read the same days for ever', async () => {
      serve(listed(100), listed(50), listed(30), listed(1));
      await sync.syncFlights(panel());
      const oldest = panel().fshubFlightCursor;
      now += 2 * DAY;
      await sync.syncFlights(panel());
      assert.ok(panel().fshubFlightCursor > oldest);
      const lastCall = fshub.flightCalls.at(-1)!;
      assert.ok(lastCall.cursor >= oldest);
      assert.ok(RESCAN_MS >= 24 * HOUR, 'but always keeps a day of overlap');
    });

    it('forgets flights that landed more than a week ago', async () => {
      serve(listed(3));
      h.store.upsertFshubFlights(h.panel.id, [fl({ arrivedAt: now - FLIGHT_KEEP_MS - HOUR })]);
      const r = await sync.syncFlights(panel());
      assert.equal(r.kept, 1);
    });

    it('does not keep a flight dated in the future', async () => {
      serve(listed(-5), listed(1));
      assert.equal((await sync.syncFlights(panel())).kept, 1);
    });

    it('reads a few pages a pass and carries on at the next pass when there are more', async () => {
      for (let i = 0; i < 1500; i++) serve(listed(100 - i * 0.05, { pilotId: 500 + (i % 50) }));
      const first = await sync.syncFlights(panel());
      assert.equal(first.kept, 1000, 'ten pages of a hundred');
      assert.equal(panel().fshubFlightsAt, now - FLIGHT_SYNC_MS, 'and it is due again at once');
      await sync.run();
      assert.equal(h.store.countFshubFlights(h.panel.id), 1500);
      assert.ok(panel().fshubFlightsAt === now, 'caught up');
    });
  });

  describe('when it fails', () => {
    it('says why on the panel, deletes nothing, and clears the warning on the next good read', async () => {
      serve(listed(3));
      await sync.syncFlights(panel());
      fshub.flightError = new FsHubError('no-access', 'Only members can see this.');
      now += 6 * 60_000;
      const r = await sync.syncFlights(panel());
      assert.deepEqual([r.ok, r.note, r.kept], [false, 'Only members can see this.', 1]);
      assert.equal(panel().fshubFlightsNote, 'Only members can see this.');
      fshub.flightError = null;
      now += 6 * 60_000;
      await sync.syncFlights(panel());
      assert.equal(panel().fshubFlightsNote, null);
    });

    it('copes with something unexpected, and says so without the details', async () => {
      fshub.flightError = new Error('kaboom with details nobody should see');
      const r = await sync.syncFlights(panel());
      assert.equal(r.ok, false);
      assert.doesNotMatch(r.note!, /kaboom/);
    });

    it('does nothing for a panel that is not linked, or that has confirming switched off', async () => {
      h.store.updatePanel(h.panel.id, { fshubAirlineId: null });
      assert.equal((await sync.syncFlights(panel())).ok, false);
      h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE_ID, fshubConfirm: false });
      const r = await sync.syncFlights(panel());
      assert.equal(r.ok, false);
      assert.equal(fshub.flightCalls.length, 0);
    });
  });

  describe('as the scheduler runs it', () => {
    it('reads the roster hourly and the flights every five minutes', async () => {
      serve(listed(3));
      fshub.rosters.set(AIRLINE_ID, []);
      await sync.run();
      assert.deepEqual([fshub.rosterCalls.length, h.store.countFshubFlights(h.panel.id)], [1, 1]);
      const calls = () => fshub.flightCalls.length;
      const before = calls();
      now += FLIGHT_SYNC_MS - 1;
      await sync.run();
      assert.equal(calls(), before, 'not yet');
      now += 1;
      await sync.run();
      assert.ok(calls() > before, 'five minutes on');
      assert.equal(fshub.rosterCalls.length, 1, 'the roster is not due');
      now += FSHUB_SYNC_MS;
      await sync.run();
      assert.equal(fshub.rosterCalls.length, 2);
    });

    it('does not bother asking for flights when the roster could not be read at all', async () => {
      fshub.rosterError = new FsHubError('no-access', 'Only members can see this.');
      await sync.run();
      assert.equal(fshub.flightCalls.length, 0);
    });

    it('does not read flights for a panel with confirming off', async () => {
      h.store.updatePanel(h.panel.id, { fshubConfirm: false });
      fshub.rosters.set(AIRLINE_ID, []);
      await sync.run();
      assert.equal(fshub.rosterCalls.length, 1);
      assert.equal(fshub.flightCalls.length, 0);
    });
  });

  describe('redrawing the panel', () => {
    const completedFlight = () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { availableFrom: now - 6 * HOUR, deadline: now + 6 * HOUR })]);
      const v = h.jobs.open(h.panel.id)[0]!;
      h.jobs.reserve(v.job.id, [1], USER_A);
      return h.jobs.complete(v.job.id, USER_A.discordId);
    };

    it('only when what the completed flights show has changed', async () => {
      // `completed()` and the matching clock must agree about "now", so the jobs are made against the test's clock.
      h.clock.now = now;
      completedFlight();
      const f = listed(2);
      serve(f);
      await sync.syncFlights(panel());
      assert.deepEqual(scheduled, [h.panel.id], 'a completed flight was confirmed, so the panel is redrawn');
      scheduled.length = 0;
      now += 6 * 60_000;
      await sync.syncFlights(panel());
      assert.deepEqual(scheduled, [], 'nothing changed');
      fshub.flights.set(AIRLINE_ID, [{ ...f, scheduleStatus: 'DELAYED' }]);
      now += 6 * 60_000;
      await sync.syncFlights(panel());
      assert.deepEqual(scheduled, [h.panel.id], 'FsHub changed its mind about the status');
    });

    it('not at all when no completed flight is affected', async () => {
      serve(listed(2));
      await sync.syncFlights(panel());
      assert.deepEqual(scheduled, []);
    });
  });
});

/* ------------------------------------------------------------------ in Discord */

describe('on the panel and in the DM', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  let pid: number;
  const panelText = () => d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');
  const press = async (user: FakeUser, customId: string, o: { values?: string[] } = {}) => {
    const f = fakeComponent(user, customId, o);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const arrived = (offset: number, over: Partial<FlownFlight> = {}) => fl({ pilotId: 1001, arrivedAt: T0 + offset, aircraftIcao: 'B738', aircraftName: 'Boeing 737-800', ...over });

  beforeEach(async () => {
    h = await makeHarness();
    fshub = new FakeFsHub();
    d = makeDiscordHarness(h, { fshub }); // Alice (USER_A) already has FsHub pilot ID 1001
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    pid = h.panel.id;
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    h.jobs.sync(pid, [
      sj('s', 'EGLL-EGKK', { availableFrom: T0, deadline: T0 + 12 * HOUR, aircraft: 'A320' }),
      sj('t', 'EGKK-EGCC', { availableFrom: T0, deadline: T0 + 12 * HOUR, aircraft: 'B738' }),
    ]);
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const jobId = (key: string) => h.jobs.open(pid).find((v) => v.job.sourceKey === key)!.job.id;

  it('shows the aircraft flown under a completed flight on the panel', async () => {
    h.store.upsertFshubFlights(pid, [arrived(3 * HOUR)]);
    h.jobs.reserve(jobId('s'), [1], USER_A);
    h.jobs.complete(jobId('s'), USER_A.discordId);
    await d.panels.refresh(pid);
    const text = panelText();
    assert.match(text, /^TST-001 · B738 · on time\n## EGLL ✈ EGKK\n\*Boeing 737-800\*\n⚠️ scheduled A320$/m, 'the aircraft that was flown, and that it is not the one that was scheduled');
    assert.match(text, /^FLOWN BY: <@\d+> · FsHub #1001$/m);
    assert.match(text, /^LANDED: <t:\d+:t>$/m);
    assert.match(text, /^FSHUB: \[flight #\d+\]\(https:\/\/fshub\.io\/flight\/\d+\/report\)$/m, "FsHub's own flight number, as a link");
  });

  it('shows nothing extra when FsHub has not seen the flight, or confirming is off', async () => {
    h.jobs.reserve(jobId('s'), [1], USER_A);
    h.jobs.complete(jobId('s'), USER_A.discordId);
    await d.panels.refresh(pid);
    assert.doesNotMatch(panelText(), /^(LANDED|FSHUB):/m);
    h.store.upsertFshubFlights(pid, [arrived(3 * HOUR)]);
    h.store.updatePanel(pid, { fshubConfirm: false });
    await d.panels.refresh(pid);
    assert.doesNotMatch(panelText(), /^(LANDED|FSHUB):/m);
    h.store.updatePanel(pid, { fshubConfirm: true });
    await d.panels.refresh(pid);
    assert.match(panelText(), /^FSHUB: /m);
  });

  it('says under My flights which of a pilot\'s flights FsHub shows flown, and points to Complete', async () => {
    h.jobs.reserve(jobId('s'), [1], USER_A);
    h.jobs.reserve(jobId('t'), [1], USER_A);
    h.store.upsertFshubFlights(pid, [arrived(3 * HOUR, { dep: 'EGLL', arr: 'EGKK', aircraftIcao: 'A320', aircraftName: 'Airbus A320' })]);
    const calls = await press(alice, `panel:mine:${pid}`);
    const text = calls.edits[0].content as string;
    assert.match(text, /\*\*TST-001\*\* · EGLL → EGKK[^\n]*\n↳ 🛬 FsHub shows this flown: A320 \(Airbus A320\), landed <t:\d+:t> · on time/);
    assert.doesNotMatch(text.split('\n').find((l) => l.includes('TST-002'))!, /🛬/);
    assert.equal((text.match(/🛬/g) ?? []).length, 1, 'only the one that was flown');
    assert.match(text, /press \*\*Complete\*\*/);
  });

  it('leaves My flights as it was when there is nothing from FsHub', async () => {
    h.jobs.reserve(jobId('s'), [1], USER_A);
    const text = (await press(alice, `panel:mine:${pid}`)).edits[0].content as string;
    assert.doesNotMatch(text, /FsHub shows|press \*\*Complete\*\*/);
  });

  it('does not talk about FsHub in the completion step for a panel that is not linked, or when the bot has no FsHub token', async () => {
    h.jobs.reserve(jobId('s'), [1], USER_A);
    h.store.updatePanel(pid, { fshubAirlineId: null });
    assert.doesNotMatch((await press(alice, `panel:completepick:${pid}`, { values: [String(jobId('s'))] })).updates[0].content, /FsHub/);
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID });
    d.ctx.fshub = null;
    assert.doesNotMatch((await press(alice, `panel:completepick:${pid}`, { values: [String(jobId('s'))] })).updates[0].content, /FsHub/);
  });
});

/* ------------------------------------------------------------------ /setup fshub confirm */

describe('/setup fshub and the airline\'s flights', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  const AIRLINE = { id: AIRLINE_ID, name: 'Test Air', abbr: 'TST' };

  beforeEach(async () => {
    h = await makeHarness();
    fshub = new FakeFsHub();
    fshub.mine = [AIRLINE];
    fshub.airlines.set(AIRLINE_ID, AIRLINE);
    fshub.rosters.set(AIRLINE_ID, [{ id: 500, name: 'Ann Pilot', discordId: USER_A.discordId }]);
    d = makeDiscordHarness(h, { pilotIds: false, fshub });
    h.clock.now = T0;
    fshub.flights.set(AIRLINE_ID, [
      { id: 4_900_001, pilotId: 500, pilotName: 'Ann Pilot', dep: 'EGLL', arr: 'EGKK', departedAt: T0 - 5 * HOUR, arrivedAt: T0 - 4 * HOUR, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME' },
      { id: 4_900_002, pilotId: 501, pilotName: 'Bob Pilot', dep: 'EGKK', arr: 'EGLL', departedAt: T0 - 3 * HOUR, arrivedAt: T0 - 2 * HOUR, aircraftIcao: 'B738', aircraftName: 'Boeing 737-800', scheduleStatus: 'DELAYED' },
    ]);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const run = async (o: Record<string, unknown>, sub = 'fshub') => {
    const f = fakeInteraction({ sub, admin: true, options: o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };
  const panel = () => h.store.getPanel(h.panel.id)!;

  it('has a confirm option with on and off', () => {
    const json = setup.data.toJSON();
    const sub = (json.options ?? []).find((o) => o.name === 'fshub') as unknown as { options: Array<{ name: string; choices?: Array<{ value: string }>; description: string }> };
    const confirm = sub.options.find((o) => o.name === 'confirm')!;
    assert.deepEqual(confirm.choices!.map((c) => c.value), ['on', 'off']);
    assert.ok(confirm.description.length <= 100);
  });

  it('reads the airline\'s recent flights when it links the panel, and says so', async () => {
    const reply = await run({ link: 'TST' });
    assert.match(reply, /linked to \*\*Test Air \(TST\)\*\* on FsHub/);
    assert.match(reply, /I also read the airline's recent FsHub flights \(2 from the last week\)/);
    assert.match(reply, /\/setup fshub confirm:off/);
    assert.equal(h.store.countFshubFlights(h.panel.id), 2);
    assert.equal(panel().fshubFlightsNote, null);
  });

  it('still links when the flights cannot be read yet, and says it will keep trying', async () => {
    fshub.flightError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
    const reply = await run({ link: 'TST' });
    assert.match(reply, /linked to \*\*Test Air \(TST\)\*\*/);
    assert.match(reply, /⚠️ I couldn't read the airline's recent flights yet: I couldn't reach FsHub right now\. I'll keep trying\./);
    assert.equal(panel().fshubAirlineId, AIRLINE_ID);
  });

  it('with no link, reads the roster and the flights now', async () => {
    await run({ link: 'TST' });
    fshub.flights.set(AIRLINE_ID, [...fshub.flights.get(AIRLINE_ID)!, { id: 4_900_003, pilotId: 502, pilotName: null, dep: 'EGLL', arr: 'EGCC', departedAt: T0, arrivedAt: T0 + HOUR, aircraftIcao: 'A320', aircraftName: null, scheduleStatus: null }]);
    const reply = await run({});
    assert.match(reply, /\(3 from the last week\)/);
  });

  it('confirm:off stops the reading, deletes what was kept, and says so; confirm:on starts it again', async () => {
    await run({ link: 'TST' });
    const off = await run({ confirm: 'off' });
    assert.match(off, /stopped reading the airline's FsHub flights.*deleted the ones I had kept/);
    assert.deepEqual([panel().fshubConfirm, h.store.countFshubFlights(h.panel.id), panel().fshubFlightCursor], [false, 0, 0]);
    assert.equal(panel().fshubAirlineId, AIRLINE_ID, 'the roster link stays');
    const callsBefore = fshub.flightCalls.length;
    await d.ctx.fshubSync!.run();
    assert.equal(fshub.flightCalls.length, callsBefore, 'and nothing is read');
    const on = await run({ confirm: 'on' });
    assert.match(on, /I'll read the airline's recent FsHub flights/);
    assert.match(on, /\(2 from the last week\)/);
    assert.equal(panel().fshubConfirm, true);
  });

  it('unlinking forgets the flights too, and a different airline starts afresh', async () => {
    await run({ link: 'TST' });
    assert.equal(h.store.countFshubFlights(h.panel.id), 2);
    assert.match(await run({ link: 'none' }), /Stopped reading a FsHub roster and flights/);
    assert.deepEqual([h.store.countFshubFlights(h.panel.id), panel().fshubFlightCursor, panel().fshubAirlineId], [0, 0, null]);

    await run({ link: 'TST' });
    h.store.upsertFshubFlights(h.panel.id, [fl()]);
    fshub.airlines.set(6000, { id: 6000, name: 'Second Air', abbr: 'SEC' });
    fshub.rosters.set(6000, []);
    fshub.flights.set(6000, []);
    await run({ link: '6000' });
    assert.equal(h.store.countFshubFlights(h.panel.id), 0, "another airline's flights are no use");
  });

  it('shows the flights\' state in /setup panels', async () => {
    const panels = async () => {
      const f = fakeInteraction({ sub: 'panels', admin: true });
      await setup.execute(d.ctx, f.i);
      return String(f.calls.edits.at(-1)?.content ?? '');
    };
    await run({ link: 'TST' });
    assert.match(await panels(), /FsHub flights: 2 kept, read <t:\d+:R>/);
    h.store.updatePanel(h.panel.id, { fshubFlightsNote: 'FsHub is busy' });
    assert.match(await panels(), /FsHub flights: ⚠️ FsHub is busy/);
    h.store.updatePanel(h.panel.id, { fshubConfirm: false });
    assert.match(await panels(), /FsHub flights: off/);
  });

  it('the panel redraws with the aircraft once the flights are read', async () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK', { availableFrom: T0 - 12 * HOUR, deadline: T0 + 6 * HOUR, aircraft: 'A320' })]);
    const v = h.jobs.open(h.panel.id)[0]!;
    h.store.setPilotId(USER_A.discordId, 500, T0);
    h.jobs.reserve(v.job.id, [1], USER_A);
    h.jobs.complete(v.job.id, USER_A.discordId);
    await d.panels.refresh(h.panel.id);
    const text = () => d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');
    assert.doesNotMatch(text(), /^(LANDED|FSHUB):/m);
    await run({ link: 'TST' });
    await settle(1700); // the redraw is debounced
    assert.match(text(), /^TST-001 · A320 · on time\n## EGLL ✈ EGKK\n\*Airbus A320\*$/m);
    assert.match(text(), /^LANDED: <t:\d+:t>$/m);
    assert.doesNotMatch(text(), /⚠️ scheduled/, 'it was the scheduled aircraft');
  });
});

void USER_B;
