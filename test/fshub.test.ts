import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MIGRATIONS, openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { matchAirline, parseAirlineRef } from '../src/fshub/airlineRef.js';
import {
  FsHubClient,
  FsHubError,
  fshubTokenProblem,
  normalizeFsHubToken,
  parseRosterPage,
  quoteDiscordIds,
  type FsHubErrorKind,
} from '../src/fshub/client.js';
import { FSHUB_SYNC_MS, FsHubSync } from '../src/services/fshubSync.js';
import type { Logger } from '../src/util/log.js';
import { GUILD, T0, USER_A, USER_B, makeHarness, type Harness } from './helpers.js';
import { FakeFsHub } from './discord-helpers.js';

/* Everything below is made up. The pilots, airlines and Discord IDs are not real people. */

const TOKEN = 'tok-0123456789abcdefghijkl';
const DISCORD_1 = '234567890123456789'; // 18 digits: more than a JavaScript number can hold exactly
const DISCORD_2 = '345678901234567890';

/** One roster entry as FsHub writes it: the Discord ID is a bare number, not a string. */
const entry = (id: number, name: string, discord: string | null) =>
  `{"id":${id},"name":${JSON.stringify(name)},"base":"EGLL","locale":"en","gps":{"lat":1,"lng":2},"is_online":false,"online_at":"2026-01-01T00:00:00Z","discord_id":${discord ?? 'null'},"is_premium":false}`;
const page = (entries: string[], next = 0) => `{"data":[${entries.join(',')}],"meta":{"cursor":{"current":0,"prev":0,"next":${next},"count":${entries.length}}}}`;

interface Call {
  url: string;
  path: string;
  query: URLSearchParams;
  init: RequestInit | undefined;
}

/** A fetch that records requests and answers from a function. */
function fakeFetch(answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const call = { url: String(url), path: u.pathname.replace(/^\/api\/v3/, ''), query: u.searchParams, init };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const raw = (text: string, status = 200) => new Response(text, { status });

function captureLog() {
  const lines: string[] = [];
  const log: Logger = { debug: (m) => lines.push(m), info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  return { lines, log };
}

const rejectsWith = (p: Promise<unknown>, kind: FsHubErrorKind) =>
  assert.rejects(p, (e: unknown) => e instanceof FsHubError && e.kind === kind, kind);

describe('the FsHub token', () => {
  it('is tidied: no quotes, no "Bearer", no header name', () => {
    assert.equal(normalizeFsHubToken('  "abc123"  '), 'abc123');
    assert.equal(normalizeFsHubToken('Bearer abc123'), 'abc123');
    assert.equal(normalizeFsHubToken('X-Pilot-Token: abc123'), 'abc123');
  });

  it('is only accepted if it could be a token, so nothing odd ever reaches a header', () => {
    assert.equal(fshubTokenProblem(TOKEN), null);
    for (const bad of ['', '   ', 'short', 'two words 0123456789abcdef', `${TOKEN}\r\nX-Evil: 1`, 'é'.repeat(30), 'a'.repeat(300)]) {
      assert.notEqual(fshubTokenProblem(bad), null, JSON.stringify(bad).slice(0, 30));
    }
  });
});

describe('reading what FsHub sends', () => {
  it('keeps Discord IDs exactly, however many digits they have', () => {
    const body = `{"discord_id":${DISCORD_1},"x":{"discord_id": ${DISCORD_2}}}`;
    assert.ok(Number(DISCORD_1).toString() !== DISCORD_1, 'the test ID really is too big for a number');
    const parsed = JSON.parse(quoteDiscordIds(body));
    assert.equal(parsed.discord_id, DISCORD_1);
    assert.equal(parsed.x.discord_id, DISCORD_2);
    assert.equal(quoteDiscordIds('{"discord_id":null,"id":123456789012345678}'), '{"discord_id":null,"id":123456789012345678}', 'only that field');
  });

  it('skips an entry it cannot read rather than losing the rest, and drops anything that is not a Discord ID', () => {
    const list = parseRosterPage([
      { id: 1, name: 'Ann Pilot', discord_id: DISCORD_1 },
      { id: 'two', name: 'Bad ID' },
      { id: 3, name: '' },
      { id: 4, name: 'No Discord', discord_id: null },
      { id: 5, name: 'Short', discord_id: '12345' },
      { id: 6, name: 'Words', discord_id: 'not-a-number-at-all-xx' },
      { id: 7, name: '  Multi \n line\u0000 name  ', discord_id: DISCORD_2 },
      null,
      'junk',
    ]);
    assert.deepEqual(
      list.map((p) => [p.id, p.name, p.discordId]),
      [
        [1, 'Ann Pilot', DISCORD_1],
        [4, 'No Discord', null],
        [5, 'Short', null],
        [6, 'Words', null],
        [7, 'Multi line name', DISCORD_2],
      ],
    );
  });

  it('shortens absurdly long names', () => {
    const [p] = parseRosterPage([{ id: 1, name: 'x'.repeat(500), discord_id: null }]);
    assert.equal(p!.name.length, 60);
  });
});

describe('the FsHub client', () => {
  let clock: number;
  beforeEach(() => {
    clock = T0;
  });
  const make = (answer: (c: Call) => Response | Promise<Response>, log?: Logger) => {
    const f = fakeFetch(answer);
    return { ...f, client: new FsHubClient({ token: TOKEN, fetchFn: f.fetchFn, now: () => clock, logger: log }) };
  };

  it('only ever sends GETs to FsHub, with the token in a header and never in the address', async () => {
    const { client, calls } = make((c) => {
      if (c.path === '/user') return json({ data: { id: 5, name: 'Token Holder', is_premium: true } });
      if (c.path === '/pilot/5/airline') return json({ data: [{ id: 9, name: 'Test Air', abbr: 'TST' }] });
      if (c.path.startsWith('/pilot/')) return json({ data: { id: 12, name: 'Ann Pilot', base: 'EGLL', country: 'GB' } });
      if (c.path === '/airline/9') return json({ data: { id: 9, name: 'Test Air', abbr: 'TST' } });
      return raw(page([entry(1, 'Ann', DISCORD_1)]));
    });
    assert.deepEqual(await client.account(), { id: 5, name: 'Token Holder', premium: true });
    assert.equal((await client.pilot(12))!.name, 'Ann Pilot');
    assert.equal((await client.airline(9))!.abbr, 'TST');
    assert.equal((await client.myAirlines()).length, 1);
    assert.equal((await client.roster(9)).length, 1);
    assert.ok(calls.length >= 5);
    for (const c of calls) {
      assert.ok(c.url.startsWith('https://fshub.io/api/v3/'), c.url);
      assert.equal(c.init?.method, 'GET');
      assert.equal((c.init?.headers as Record<string, string>)['x-pilot-token'], TOKEN);
      assert.equal(c.url.includes(TOKEN), false, 'not in the address');
      assert.equal(c.init?.redirect, 'error', 'a redirect is an error, so the token can never be sent somewhere else');
      assert.equal(c.init?.body, undefined);
    }
  });

  it('refuses an ID that is not a positive whole number before it can become part of an address', async () => {
    const { client, calls } = make(() => json({ data: {} }));
    for (const bad of [0, -3, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await assert.rejects(client.pilot(bad), /Not a FsHub ID/);
      await assert.rejects(client.airline(bad), /Not a FsHub ID/);
      await assert.rejects(client.roster(bad), /Not a FsHub ID/);
    }
    assert.equal(calls.length, 0);
  });

  describe('a pilot', () => {
    it('is found, or null when FsHub has no such pilot', async () => {
      const { client } = make((c) => (c.path === '/pilot/42' ? json({ data: { id: 42, name: 'Ann Pilot', base: 'EGLL', country: 'GB' } }) : json({ error: true, message: 'Pilot not found', details: { pilot: 7 } }, 404)));
      assert.deepEqual(await client.pilot(42), { id: 42, name: 'Ann Pilot', base: 'EGLL', country: 'GB' });
      assert.equal(await client.pilot(7), null);
    });

    it('is remembered for a while, a missing one only briefly', async () => {
      const { client, calls } = make((c) => (c.path === '/pilot/42' ? json({ data: { id: 42, name: 'Ann Pilot' } }) : json({ error: true, message: 'Pilot not found' }, 404)));
      await client.pilot(42);
      await client.pilot(42);
      await client.pilot(7);
      await client.pilot(7);
      assert.equal(calls.length, 2, 'the repeats were answered from memory');
      clock += 61_000;
      await client.pilot(7);
      await client.pilot(42);
      assert.equal(calls.length, 3, 'the missing one is asked again after a minute; the found one is still remembered');
      clock += 10 * 60_000;
      await client.pilot(42);
      assert.equal(calls.length, 4);
    });

    it('a profile it cannot read is an error, not a missing pilot', async () => {
      const { client } = make(() => json({ data: { id: 'x' } }));
      await rejectsWith(client.pilot(1), 'bad-response');
    });
  });

  describe("an airline's roster", () => {
    const pageOf = (from: number, count: number) => Array.from({ length: count }, (_, i) => entry(from + i, `Pilot ${from + i}`, i === 0 ? DISCORD_1 : null));

    it('is read page by page until the last one, keeping every Discord ID exact', async () => {
      const { client, calls } = make((c) => {
        const cursor = Number(c.query.get('cursor') ?? 0);
        if (cursor === 0) return raw(page(pageOf(1, 100), 100));
        if (cursor === 100) return raw(page([entry(101, 'Last One', DISCORD_2), entry(102, 'Another', null)], 102));
        return json({ error: true, message: 'No records found' }, 404);
      });
      const roster = await client.roster(9);
      assert.equal(roster.length, 102);
      assert.equal(roster[0]!.discordId, DISCORD_1);
      assert.equal(roster[100]!.discordId, DISCORD_2);
      assert.equal(roster[101]!.discordId, null);
      assert.deepEqual(
        calls.map((c) => [c.path, c.query.get('limit'), c.query.get('cursor')]),
        [
          ['/airline/9/pilot', '100', null],
          ['/airline/9/pilot', '100', '100'],
        ],
        'a short page is the last one, so there is no third request',
      );
    });

    it('stops when FsHub says there are no more records, or nobody is on the roster', async () => {
      const full = make((c) => (c.query.get('cursor') ? json({ error: true, message: 'No records found' }, 404) : raw(page(pageOf(1, 100), 100))));
      assert.equal((await full.client.roster(9)).length, 100);
      assert.equal(full.calls.length, 2);
      const none = make(() => new Response(null, { status: 204 }));
      assert.deepEqual(await none.client.roster(9), []);
      const gone = make(() => json({ error: true, message: 'No records found' }, 404));
      assert.deepEqual(await gone.client.roster(9), []);
    });

    it('cannot be sent round in circles by an answer that never moves on', async () => {
      const { client, calls } = make(() => raw(page(pageOf(1, 100), 0)));
      assert.equal((await client.roster(9)).length, 100);
      assert.equal(calls.length, 1);
      const stuck = make(() => raw(page(pageOf(1, 100), 100)));
      await stuck.client.roster(9);
      assert.equal(stuck.calls.length, 2, 'the same cursor twice and it stops');
    });

    it('never asks for more than a sensible number of pages', async () => {
      let next = 0;
      const { client, calls } = make(() => raw(page(pageOf(1 + next, 100), (next += 100))));
      const roster = await client.roster(9);
      assert.equal(calls.length, 30);
      assert.equal(roster.length, 3000);
    });

    it('lists someone once even if two pages both carry them', async () => {
      const { client } = make((c) => (c.query.get('cursor') ? raw(page([entry(1, 'Same', DISCORD_2)], 1)) : raw(page(pageOf(1, 100), 100))));
      const roster = await client.roster(9);
      assert.equal(roster.length, 100);
      assert.equal(roster[0]!.discordId, DISCORD_2, 'the later entry wins');
    });
  });

  it("finds the airlines the token's own account belongs to", async () => {
    const { client, calls } = make((c) => (c.path === '/user' ? json({ data: { id: 5, name: 'Me' } }) : c.path === '/pilot/5/airline' ? json({ data: [{ id: 9, name: 'Test Air', abbr: 'TST', owner: { id: 1 } }, { id: 'bad' }] }) : json({}, 500)));
    assert.deepEqual(await client.myAirlines(), [{ id: 9, name: 'Test Air', abbr: 'TST' }]);
    assert.deepEqual(calls.map((c) => c.path), ['/user', '/pilot/5/airline']);
    const none = make((c) => (c.path === '/user' ? json({ data: { id: 5, name: 'Me' } }) : new Response(null, { status: 204 })));
    assert.deepEqual(await none.client.myAirlines(), []);
  });

  describe('when something goes wrong', () => {
    const answers: Array<[string, () => Response, FsHubErrorKind]> = [
      ['a token FsHub does not know', () => json({ error: { status_code: 401, message: 'Unauthenticated.' } }, 401), 'rejected'],
      ['a valid token without access to the roster', () => json({ error: true, message: 'Only airline members or premium accounts can access this endpoint.' }, 401), 'no-access'],
      ['a refusal', () => json({ error: true, message: 'Forbidden' }, 403), 'no-access'],
      ['being asked to slow down', () => raw('', 429), 'rate-limited'],
      ['FsHub being down', () => raw('oops', 503), 'unavailable'],
      ['an answer that is not JSON', () => raw('<html>hello</html>'), 'bad-response'],
      ['an answer with nothing in it', () => raw(''), 'bad-response'],
      ['an answer far too large', () => raw(`{"data":"${'x'.repeat(2_100_000)}"}`), 'bad-response'],
    ];
    for (const [what, answer, kind] of answers) {
      it(`is reported as "${kind}" for ${what}, in words that are safe to show`, async () => {
        const { lines, log } = captureLog();
        const { client } = make(answer, log);
        for (const call of [() => client.pilot(1), () => client.roster(1), () => client.account()]) {
          await assert.rejects(call(), (e: unknown) => {
            assert.ok(e instanceof FsHubError);
            // 404 is not an error for a pilot or a roster (they come back as null/empty), so this is for the others.
            assert.equal(e.kind, kind);
            assert.equal(e.message.includes(TOKEN), false);
            assert.ok(e.message.length < 250);
            return true;
          });
        }
        assert.equal(lines.some((l) => l.includes(TOKEN)), false, 'the token is never logged');
      });
    }

    it('is reported as "unavailable" when FsHub cannot be reached at all', async () => {
      const { lines, log } = captureLog();
      const { client } = make(() => {
        throw new TypeError(`fetch failed ${TOKEN}`);
      }, log);
      await rejectsWith(client.pilot(1), 'unavailable');
      await assert.rejects(client.pilot(1), (e: Error) => !e.message.includes(TOKEN));
      assert.ok(lines.length > 0, 'the failure was noted');
      assert.equal(lines.some((l) => l.includes(TOKEN)), false, 'even a network error that happens to quote the token is not logged with it');
    });
  });

  it('holds itself to a fair number of requests, and gives the budget back as time passes', async () => {
    const { client, calls } = make(() => json({ data: { id: 1, name: 'Ann' } }));
    for (let i = 1; i <= 40; i++) await client.pilot(1000 + i);
    assert.equal(calls.length, 40);
    await rejectsWith(client.pilot(2000), 'rate-limited');
    assert.equal(calls.length, 40, 'the 41st request never left');
    clock += 61_000;
    await client.pilot(2000);
    assert.equal(calls.length, 41);
  });
});

describe('saying which airline you mean', () => {
  it('understands a number, a link, or a name', () => {
    assert.deepEqual(parseAirlineRef('8123'), { kind: 'id', id: 8123 });
    assert.deepEqual(parseAirlineRef(' #8123 '), { kind: 'id', id: 8123 });
    assert.deepEqual(parseAirlineRef('https://fshub.io/airline/8123/overview'), { kind: 'id', id: 8123 });
    assert.deepEqual(parseAirlineRef('fshub.io/airline/SKY/overview'), { kind: 'name', text: 'SKY' });
    assert.deepEqual(parseAirlineRef('SKY'), { kind: 'name', text: 'SKY' });
    assert.deepEqual(parseAirlineRef('"Test Air"'), { kind: 'name', text: 'Test Air' });
  });

  it('refuses what cannot be one', () => {
    for (const bad of ['', '   ', '0', 'x', 'https://example.com/airline/8123', 'evil.example/airline/1/x', 'a'.repeat(61), 'bad\u0000name']) {
      assert.equal(parseAirlineRef(bad), null, JSON.stringify(bad));
    }
  });

  it('matches by short name first, then full name, ignoring capitals', () => {
    const mine = [
      { id: 1, name: 'Test Air', abbr: 'TST' },
      { id: 2, name: 'TST', abbr: null },
    ];
    assert.equal(matchAirline(mine, 'tst')!.id, 1);
    assert.equal(matchAirline(mine, 'test AIR')!.id, 1);
    assert.equal(matchAirline(mine, 'nope'), null);
  });
});

describe('what the store keeps about FsHub', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('keeps an ID, the name FsHub has for it, and who supplied it', () => {
    h.store.setPilotId(USER_A.discordId, 1234, T0, 'Ann Pilot');
    assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 1234, name: 'Ann Pilot', source: 'typed' });
    assert.equal(h.store.getPilotId(USER_A.discordId), 1234);
    h.store.setPilotId(USER_A.discordId, 99, T0 + 1);
    assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 99, name: null, source: 'typed' }, 'a new ID drops the old name');
    assert.equal(h.store.getPilotLink('999'), null);
  });

  describe('applying a roster', () => {
    const link = (discordId: string, fshubId: number, name: string) => ({ discordId, fshubId, name });

    it('gives someone with no saved ID the roster\'s, as a roster-sourced one', () => {
      assert.deepEqual(h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann Pilot')], T0), [USER_A.discordId]);
      assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 500, name: 'Ann Pilot', source: 'roster' });
    });

    it('brings a roster-sourced ID up to date, and says nothing changed when nothing did', () => {
      h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann Pilot')], T0);
      assert.deepEqual(h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann Pilot')], T0 + 1), []);
      assert.deepEqual(h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann P. Pilot')], T0 + 2), [USER_A.discordId]);
      assert.deepEqual(h.store.applyRosterLinks([link(USER_A.discordId, 777, 'Ann P. Pilot')], T0 + 3), [USER_A.discordId]);
      assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 777, name: 'Ann P. Pilot', source: 'roster' });
    });

    it('never replaces an ID the pilot typed, even if the roster disagrees', () => {
      h.store.setPilotId(USER_A.discordId, 1234, T0, 'Typed Name');
      assert.deepEqual(h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Roster Name')], T0 + 1), []);
      assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 1234, name: 'Typed Name', source: 'typed' });
    });

    it('only freshens the name beside a typed ID when the roster agrees it is the same pilot', () => {
      h.store.setPilotId(USER_A.discordId, 500, T0, null);
      assert.deepEqual(h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann Pilot')], T0 + 1), [USER_A.discordId]);
      assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 500, name: 'Ann Pilot', source: 'typed' }, 'still counts as typed');
    });

    it('a pilot typing an ID after the roster supplied one replaces it, and then it is theirs', () => {
      h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann Pilot')], T0);
      h.store.setPilotId(USER_A.discordId, 600, T0 + 1, 'Other');
      h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann Pilot')], T0 + 2);
      assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 600, name: 'Other', source: 'typed' });
    });

    it('applies the whole roster or none of it', () => {
      assert.throws(() => h.store.applyRosterLinks([link(USER_A.discordId, 500, 'Ann'), { discordId: USER_B.discordId, fshubId: null as unknown as number, name: 'Bob' }], T0));
      assert.equal(h.store.getPilotLink(USER_A.discordId), null);
    });
  });

  it('shows the name and ID on a reservation, from either source', () => {
    h.jobs.sync(h.panel.id, [{ key: 'a', title: null, legs: [{ dep: 'EGLL', arr: 'EGKK' }], aircraft: null, availableFrom: null, deadline: T0 + 3_600_000, pay: null, notes: null }]);
    const job = h.jobs.open(h.panel.id)[0]!.job;
    h.jobs.reserve(job.id, [1], USER_A);
    assert.equal(h.store.getHolder(job.id, 1)!.fshubId, null);
    h.store.applyRosterLinks([{ discordId: USER_A.discordId, fshubId: 500, name: 'Ann Pilot' }], T0);
    const holder = h.store.getHolder(job.id, 1)!;
    assert.deepEqual([holder.fshubId, holder.fshubName], [500, 'Ann Pilot']);
    assert.deepEqual([h.jobs.open(h.panel.id)[0]!.legs[0]!.holder!.fshubId, h.jobs.open(h.panel.id)[0]!.legs[0]!.holder!.fshubName], [500, 'Ann Pilot']);
  });

  it('upgrades a v11 database without losing a thing: old IDs count as typed, panels are unlinked', () => {
    // A database exactly as the previous version left it, with a panel and a pilot's ID in it...
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < 11; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    old.prepare(`INSERT INTO pilot_ids(discord_id, fshub_id, updated_at) VALUES ('u1', 4321, 5)`).run();
    // ...then the one new step.
    assert.ok(MIGRATIONS.length >= 12);
    old.exec(MIGRATIONS[11] as string);
    const store = new Store(old);
    assert.deepEqual(store.getPilotLink('u1'), { fshubId: 4321, name: null, source: 'typed' });
    const panel = store.listAllPanels()[0]!;
    assert.deepEqual([panel.fshubAirlineId, panel.fshubAirlineName, panel.fshubSyncedAt, panel.fshubNote], [null, null, null, null]);
    assert.deepEqual(store.listFshubPanels(), []);
  });

  it('adds the auto-complete switch, on, to panels that were already linked, and never checked', () => {
    const step = MIGRATIONS.findIndex((m) => m.includes('fshub_autocomplete INTEGER'));
    assert.ok(step > 0, 'the step exists');
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < step; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at, fshub_airline_id) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1, 8123)`).run();
    old.exec(MIGRATIONS[step] as string);
    const store = new Store(old);
    const panel = store.listAllPanels()[0]!;
    assert.deepEqual([panel.fshubAirlineId, panel.fshubAutoComplete, panel.fshubAutoCompleteAt], [8123, true, null]);
  });

  it('adds the day window, 7, to panels that already exist', () => {
    const step = MIGRATIONS.findIndex((m) => m.includes('show_days INTEGER'));
    assert.ok(step > 0, 'the step exists');
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < step; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    old.exec(MIGRATIONS[step] as string);
    const store = new Store(old);
    assert.equal(store.listAllPanels()[0]!.showDays, 7);
    store.updatePanel(store.listAllPanels()[0]!.id, { showDays: 3 });
    assert.equal(store.listAllPanels()[0]!.showDays, 3);
  });

  it('lets a conversation that was open before the update carry on, as a reservation', () => {
    const step = MIGRATIONS.findIndex((m) => m.includes('dm_sessions ADD COLUMN purpose'));
    assert.ok(step > 0, 'the step exists');
    const old = new DatabaseSync(':memory:');
    old.exec('PRAGMA foreign_keys = ON');
    for (let v = 0; v < step; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    old.prepare(`INSERT INTO dm_sessions(discord_id, panel_id, step, attempts, expires_at) VALUES ('555', 1, 'await_code', 0, 9999999999999)`).run();
    old.exec(MIGRATIONS[step] as string);
    const store = new Store(old);
    assert.deepEqual([store.getSession('555', 1)?.purpose, store.getSession('555', 1)?.step], ['reserve', 'await_code']);
    store.upsertSession({ discordId: '555', panelId: 1, step: 'await_code', purpose: 'backup', expiresAt: 9999999999999 });
    assert.equal(store.getSession('555', 1)?.purpose, 'backup');
    store.upsertSession({ discordId: '555', panelId: 1, step: 'await_code', expiresAt: 9999999999999 });
    assert.equal(store.getSession('555', 1)?.purpose, 'reserve', 'a conversation with no purpose given is a reservation');
  });

  describe('a database that a test build of the dropped contract-pay feature already moved to v19', () => {
    const tableExists = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'panel_contracts'").get() !== undefined;
    const version = (db: DatabaseSync) => Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    /** A database file as it stood at schema v18 (what 0.1.3 uses), optionally with what the test build's v19 added. */
    const withFile = (testBuildTable: boolean, check: (db: DatabaseSync) => void) => {
      const dir = mkdtempSync(join(tmpdir(), 'fpb-mig-'));
      try {
        const file = join(dir, 'bot.sqlite');
        const old = new DatabaseSync(file);
        old.exec('PRAGMA foreign_keys = ON');
        for (let v = 0; v < 18; v++) old.exec(MIGRATIONS[v] as string);
        old.exec('PRAGMA user_version = 18');
        if (testBuildTable) {
          old.exec("CREATE TABLE panel_contracts (panel_id INTEGER NOT NULL, contract_id INTEGER NOT NULL, schedule TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (panel_id, contract_id))");
          old.exec('PRAGMA user_version = 19');
        }
        old.close();
        const db = openDatabase(file);
        try {
          check(db);
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it('still opens, and the table that build made is cleared away', () => {
      withFile(true, (db) => {
        assert.equal(tableExists(db), false);
        assert.equal(version(db), MIGRATIONS.length);
      });
    });

    it('is no different for a database at v18, which never had that table', () => {
      withFile(false, (db) => {
        assert.equal(tableExists(db), false);
        assert.equal(version(db), MIGRATIONS.length);
      });
    });

    it('is not in a fresh database either', () => {
      const db = openDatabase(':memory:');
      assert.equal(tableExists(db), false);
      db.close();
    });
  });

  it('opens a fresh database at the newest version', () => {
    const db = openDatabase(':memory:');
    const v = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(Number(v.user_version), MIGRATIONS.length);
    db.close();
  });
});

describe('reading an airline roster into the bot', () => {
  let h: Harness;
  let fshub: FakeFsHub;
  let sync: FsHubSync;
  let scheduled: number[];
  let now: number;
  const AIRLINE_ID = 8123;

  const link = (panelId = h.panel.id) => h.store.updatePanel(panelId, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air (TST)' });
  const roster = (...r: Array<[number, string, string | null]>) => fshub.rosters.set(AIRLINE_ID, r.map(([id, name, discordId]) => ({ id, name, discordId })));
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    fshub = new FakeFsHub();
    scheduled = [];
    now = T0;
    sync = new FsHubSync(h.store, fshub, { schedule: (id) => void scheduled.push(id) }, { now: () => now });
  });
  afterEach(() => h.close());

  it('saves who is who for everyone on the roster who has told FsHub their Discord account', async () => {
    link();
    roster([500, 'Ann Pilot', USER_A.discordId], [501, 'Bob Pilot', USER_B.discordId], [502, 'No Discord', null]);
    const r = await sync.syncPanel(panel());
    assert.deepEqual(r, { ok: true, note: null, rosterSize: 3, withDiscord: 2, changed: 2 });
    assert.deepEqual(h.store.getPilotLink(USER_A.discordId), { fshubId: 500, name: 'Ann Pilot', source: 'roster' });
    assert.deepEqual(h.store.getPilotLink(USER_B.discordId), { fshubId: 501, name: 'Bob Pilot', source: 'roster' });
    assert.equal(panel().fshubSyncedAt, T0);
    assert.equal(panel().fshubNote, null);
  });

  it('redraws the panels of people whose details changed, and only those', async () => {
    link();
    h.jobs.sync(h.panel.id, [{ key: 'a', title: null, legs: [{ dep: 'EGLL', arr: 'EGKK' }], aircraft: null, availableFrom: null, deadline: T0 + 3_600_000, pay: null, notes: null }]);
    h.jobs.reserve(h.jobs.open(h.panel.id)[0]!.job.id, [1], USER_A);
    roster([500, 'Ann Pilot', USER_A.discordId], [501, 'Bob Pilot', USER_B.discordId]);
    await sync.syncPanel(panel());
    assert.deepEqual(scheduled, [h.panel.id], 'Ann holds a flight here, Bob holds nothing');
    scheduled.length = 0;
    await sync.syncPanel(panel());
    assert.deepEqual(scheduled, [], 'nothing changed, nothing redrawn');
  });

  it('leaves an ID a pilot typed alone', async () => {
    link();
    h.store.setPilotId(USER_A.discordId, 1234, T0, 'Typed');
    roster([500, 'Ann Pilot', USER_A.discordId]);
    const r = await sync.syncPanel(panel());
    assert.equal(r.changed, 0);
    assert.equal(h.store.getPilotId(USER_A.discordId), 1234);
  });

  it('reports a roster it is not allowed to read, on the panel, without throwing', async () => {
    link();
    fshub.rosterError = new FsHubError('no-access', 'Only members can see this.');
    const r = await sync.syncPanel(panel());
    assert.deepEqual([r.ok, r.note], [false, 'Only members can see this.']);
    assert.equal(panel().fshubNote, 'Only members can see this.');
    assert.equal(panel().fshubSyncedAt, T0, 'not hammered: next try is an hour away');
    fshub.rosterError = null;
    roster([500, 'Ann Pilot', USER_A.discordId]);
    now += FSHUB_SYNC_MS;
    await sync.run();
    assert.equal(panel().fshubNote, null, 'and a good read clears the warning');
  });

  it('tries again sooner when FsHub itself was the problem', async () => {
    link();
    fshub.rosterError = new FsHubError('unavailable', "I couldn't reach FsHub right now.");
    await sync.syncPanel(panel());
    fshub.rosterError = null;
    roster([500, 'Ann Pilot', USER_A.discordId]);
    now += 9 * 60_000;
    await sync.run();
    assert.equal(fshub.rosterCalls.length, 1, 'not yet');
    now += 2 * 60_000;
    await sync.run();
    assert.equal(fshub.rosterCalls.length, 2, 'after about ten minutes');
    assert.equal(h.store.getPilotId(USER_A.discordId), 500);
  });

  it('copes with something unexpected without stopping, and says so plainly', async () => {
    link();
    fshub.rosterError = new Error('kaboom with details nobody should see');
    const r = await sync.syncPanel(panel());
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.note!, /kaboom/);
  });

  it('reads only the panels that are linked and due, once an hour', async () => {
    const other = h.store.createPanel({ guildId: GUILD, name: 'Other Air', prefix: 'OTH', channelId: '700000000000000002', now: T0 });
    link();
    roster([500, 'Ann Pilot', USER_A.discordId]);
    await sync.run();
    assert.deepEqual(fshub.rosterCalls, [AIRLINE_ID], 'the unlinked panel was not touched');
    assert.equal(h.store.getPanel(other.id)!.fshubSyncedAt, null);
    now += FSHUB_SYNC_MS - 1;
    await sync.run();
    assert.equal(fshub.rosterCalls.length, 1);
    now += 1;
    await sync.run();
    assert.equal(fshub.rosterCalls.length, 2);
  });

  it('does nothing for a panel that is not linked', async () => {
    const r = await sync.syncPanel(panel());
    assert.equal(r.ok, false);
    assert.equal(fshub.rosterCalls.length, 0);
  });
});
