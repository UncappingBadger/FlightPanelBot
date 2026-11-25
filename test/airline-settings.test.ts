import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BotHandle } from '../src/bot.js';
import { renderPage } from '../src/host/page.js';
import { hostPaths, type HostPaths } from '../src/host/paths.js';
import { loadSettings, saveSettings } from '../src/host/settings.js';
import { Supervisor } from '../src/host/supervisor.js';
import { UpdateChecker } from '../src/host/updates.js';
import { startWebServer, type WebServer } from '../src/host/web.js';
import { AirlineProfits } from '../src/services/airlineProfits.js';
import { AirlineSettings, SettingsError } from '../src/services/airlineSettings.js';
import { silentLogger } from '../src/util/log.js';
import { GUILD, HOUR, T0, makeHarness, type Harness } from './helpers.js';

const NOW = T0 + 6 * HOUR;
const AIRLINE = 4242;
const BUSINESS = 77;
const BOT_ID = '1234567890123456789';
const TOKEN = `${Buffer.from(BOT_ID).toString('base64')}.Gabc12.${'x'.repeat(27)}`;
const KEY = 'test-key-1234567890';

const plane = (serial: number, type: string | null) => ({ serial, registration: `G-${serial}`, type, ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: BUSINESS });

/** An airline's aircraft on Aeroconomy: two A320 and a B738 owned, an A20N leased. */
const profitsOf = (h: Harness, counter?: { n: number }): AirlineProfits =>
  new AirlineProfits({
    store: h.store,
    account: {
      ownedAircraft: async () => {
        if (counter) counter.n++;
        return [plane(1, 'A320'), plane(2, 'A320'), plane(3, 'B738')] as never;
      },
      leasedAircraft: async () => [plane(10, 'A20N')] as never,
      aircraft: async () => null,
      logbook: async () => [],
    },
    publicClient: { pilotAircraftOwner: async () => ({ airlineId: AIRLINE, businessId: BUSINESS }) },
    now: () => h.clock.now,
  });

/* ------------------------------------------------------------------ the service */

describe('the airline settings', () => {
  let h: Harness;
  let reads: { n: number };
  let fshub: boolean;
  const make = () => new AirlineSettings({ store: h.store, profits: profitsOf(h, reads), fshub, now: () => h.clock.now });
  const pid = () => h.panel.id;
  const panel = () => h.store.getPanel(pid())!;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    reads = { n: 0 };
    fshub = true;
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE, fshubConfirm: true });
    h.store.setKv(`aero.business.${AIRLINE}`, String(BUSINESS));
  });
  afterEach(() => h.close());

  const refused = (fn: () => unknown, message: RegExp, status: 400 | 404 = 400) =>
    assert.throws(fn, (e: unknown) => e instanceof SettingsError && message.test(e.message) && e.status === status, String(message));

  describe('the airlines', () => {
    it('lists every airline the bot is set up for, and whether its safety pay is on', () => {
      const other = h.store.createPanel({ guildId: GUILD, name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '9', now: T0 });
      h.store.updatePanel(other.id, { safetyPaySince: 5 });
      assert.deepEqual(
        make().airlines().map((a) => [a.name, a.abbr, a.safetyOn]),
        [['Test Air', 'TST', false], ['Other Air', 'OTH', true]],
      );
    });

    it('says an airline is not set up (404) rather than guessing, for every call', async () => {
      const s = make();
      refused(() => s.safety(999), /not set up any more/, 404);
      refused(() => s.setSafety(999, { on: false }), /not set up any more/, 404);
      refused(() => s.setLimits(999, []), /not set up any more/, 404);
      await assert.rejects(s.fleet(999), (e: unknown) => e instanceof SettingsError && e.status === 404);
    });
  });

  describe('landing safety pay', () => {
    it('shows how it stands: off, with the airline\'s defaults, shares and what a pilot loses', () => {
      h.store.setSafetyLimits(pid(), 'A320', { warn: 350, tier1: 450, tier2: 550 }, NOW);
      assert.deepEqual(make().safety(pid()), {
        id: pid(),
        name: 'Test Air',
        on: false,
        since: null,
        cannotTurnOn: null,
        lossTier1: 0,
        lossTier2: 0,
        shareTier1: 8,
        shareTier2: 5,
        deductions: false,
        defaults: { warn: 375, tier1: 400, tier2: 600 },
        ownCount: 1,
      });
    });

    it('turns on from now, keeps the day it started when saved again, and turns off', () => {
      const s = make();
      const on = s.setSafety(pid(), { on: true });
      assert.equal(on.on, true);
      assert.equal(on.since, NOW);
      assert.equal(panel().safetyPaySince, NOW);
      h.clock.now += HOUR;
      assert.equal(s.setSafety(pid(), { on: true, shareTier1: 10 }).since, NOW, 'already on: the day it started stays');
      const off = s.setSafety(pid(), { on: false });
      assert.deepEqual([off.on, off.since], [false, null]);
    });

    it('cannot be turned on without FsHub\'s landing rates: no token, no link to the airline\'s roster, or its flights switched off', () => {
      fshub = false;
      refused(() => make().setSafety(pid(), { on: true }), /no FsHub token/);
      assert.equal(make().safety(pid()).cannotTurnOn?.includes('no FsHub token'), true, 'the page is told why too');
      fshub = true;
      h.store.updatePanel(pid(), { fshubAirlineId: null });
      refused(() => make().setSafety(pid(), { on: true }), /link Test Air to its airline's FsHub roster, in the FsHub roster tab of this page/);
      h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE, fshubConfirm: false });
      refused(() => make().setSafety(pid(), { on: true }), /switched off for Test Air/);
      assert.equal(panel().safetyPaySince, null, 'nothing was turned on');
    });

    it('can still be turned off, and its numbers changed, when FsHub is no longer connected', () => {
      make().setSafety(pid(), { on: true });
      fshub = false;
      h.store.updatePanel(pid(), { fshubAirlineId: null });
      const v = make().setSafety(pid(), { lossTier1: 25 });
      assert.equal(v.on, true);
      assert.equal(v.lossTier1, 25);
      assert.equal(make().setSafety(pid(), { on: false }).on, false);
    });

    it('changes only what it is given: the shares, what is lost of the minimum, the sheet deductions and the default limits', () => {
      const v = make().setSafety(pid(), { shareTier1: 10, shareTier2: 0, lossTier1: 15, lossTier2: 100, deductions: true, defaults: { warn: 450, tier1: 550, tier2: 650 } });
      assert.deepEqual([v.shareTier1, v.shareTier2, v.lossTier1, v.lossTier2, v.deductions], [10, 0, 15, 100, true]);
      assert.deepEqual(v.defaults, { warn: 450, tier1: 550, tier2: 650 });
      assert.deepEqual([panel().safetyWarnFpm, panel().safetyTier1Fpm, panel().safetyTier2Fpm], [450, 550, 650]);
      const again = make().setSafety(pid(), { lossTier1: 20 });
      assert.deepEqual([again.shareTier1, again.shareTier2, again.lossTier1, again.lossTier2, again.deductions, again.defaults], [10, 0, 20, 100, true, { warn: 450, tier1: 550, tier2: 650 }]);
    });

    it('leaves the limits of aircraft that have their own alone when the default changes', () => {
      h.store.setSafetyLimits(pid(), 'A320', { warn: 350, tier1: 450, tier2: 550 }, NOW);
      make().setSafety(pid(), { defaults: { warn: 450, tier1: 550, tier2: 650 } });
      assert.deepEqual(h.store.listSafetyLimits(pid()).get('A320'), { warn: 350, tier1: 450, tier2: 550 });
    });

    it('refuses a number that is not a whole per cent from 0 to 100, or limits out of order, and changes nothing at all', () => {
      const before = JSON.stringify(panel());
      for (const patch of [{ lossTier1: -1 }, { lossTier2: 101 }, { shareTier1: 12.5 }, { shareTier2: Number.NaN }, { lossTier1: null as unknown as number }] as const) {
        refused(() => make().setSafety(pid(), { ...patch, deductions: true }), /whole number of per cent, from 0 to 100/);
      }
      refused(() => make().setSafety(pid(), { shareTier1: 10, defaults: { warn: 600, tier1: 500, tier2: 700 } }), /warning limit \(600\) can't be harder than the Tier 1 limit \(500\)/);
      refused(() => make().setSafety(pid(), { shareTier1: 10, defaults: { warn: 300, tier1: 400, tier2: 9000 } }), /whole number of feet per minute from 1 to 2,500/);
      refused(() => make().setSafety(pid(), { on: 'yes' as unknown as boolean }), /on or off/);
      refused(() => make().setSafety(pid(), { deductions: 1 as unknown as boolean }), /deductions/);
      assert.equal(JSON.stringify(panel()), before);
    });

    it('is a setting of each airline: another airline in the server is not touched', () => {
      const other = h.store.createPanel({ guildId: GUILD, name: 'Other Air', prefix: 'OTH', channelId: '9', now: T0 });
      make().setSafety(pid(), { shareTier1: 33, defaults: { warn: 450, tier1: 550, tier2: 650 } });
      const o = h.store.getPanel(other.id)!;
      assert.deepEqual([o.safetyShareTier1, o.safetyWarnFpm, o.safetyTier1Fpm, o.safetyTier2Fpm], [8, 400, 500, 600]);
    });
  });

  describe('the fleet', () => {
    it('lists every type (owned and leased) with the limits it is judged by, and whether they are its own', async () => {
      h.store.setSafetyLimits(pid(), 'A320', { warn: 350, tier1: 450, tier2: 550 }, NOW);
      const f = await make().fleet(pid());
      assert.deepEqual(f.defaults, { warn: 375, tier1: 400, tier2: 600 });
      assert.deepEqual(
        f.rows.map((r) => [r.code, r.owned, r.leased, r.own, r.limits]),
        [
          ['A20N', 0, 1, false, { warn: 375, tier1: 400, tier2: 600 }],
          ['A320', 2, 0, true, { warn: 350, tier1: 450, tier2: 550 }],
          ['B738', 1, 0, false, { warn: 375, tier1: 400, tier2: 600 }],
        ],
      );
      assert.equal(f.problem, null);
      assert.equal(f.name, 'Test Air');
    });

    it('reads Aeroconomy once for a while, again when asked, and says what it could not read', async () => {
      const s = make();
      await s.fleet(pid());
      await s.fleet(pid());
      assert.equal(reads.n, 1, 'the read of a moment ago was used');
      await s.fleet(pid(), { refresh: true });
      assert.equal(reads.n, 2);
      h.store.setSafetyLimits(pid(), 'B738', { warn: 100, tier1: 200, tier2: 300 }, NOW);
      assert.deepEqual((await s.fleet(pid())).rows.find((r) => r.code === 'B738')?.limits, { warn: 100, tier1: 200, tier2: 300 }, 'the limits are always the current ones, whatever was read');
      assert.equal(reads.n, 2);
    });

    it('lists a type given limits of its own after the fleet was read (one added by its code) without reading Aeroconomy again', async () => {
      const s = make();
      assert.deepEqual((await s.fleet(pid())).rows.map((r) => r.code), ['A20N', 'A320', 'B738']);
      s.setLimits(pid(), [{ aircraft: 'dh8d', limits: { warn: 300, tier1: 400, tier2: 500 } }]);
      const f = await s.fleet(pid());
      assert.deepEqual(f.rows.map((r) => [r.code, r.owned + r.leased, r.own]), [['A20N', 1, false], ['A320', 2, false], ['B738', 1, false], ['DH8D', 0, true]]);
      assert.equal(reads.n, 1, 'Aeroconomy was asked once');
      s.setLimits(pid(), [{ aircraft: 'DH8D', limits: null }]);
      assert.deepEqual((await s.fleet(pid())).rows.map((r) => r.code), ['A20N', 'A320', 'B738'], 'and it goes again when it is put back on the default');
    });

    it('lists the types the flights were flown in and those that have limits of their own, when Aeroconomy cannot be read', async () => {
      const s = new AirlineSettings({ store: h.store, profits: null, fshub: false, now: () => h.clock.now });
      h.store.upsertFshubFlights(pid(), [{ flightId: 1, pilotId: 1, pilotName: 'x', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - HOUR, arrivedAt: NOW, aircraftIcao: 'C172', aircraftName: null, scheduleStatus: null }]);
      h.store.setSafetyLimits(pid(), 'DH8D', { warn: 300, tier1: 400, tier2: 500 }, NOW);
      const f = await s.fleet(pid());
      assert.deepEqual(f.rows.map((r) => [r.code, r.flown, r.own]), [['C172', true, false], ['DH8D', false, true]]);
      assert.match(f.problem ?? '', /no FsHub token/);
    });

    it('takes the airline\'s business number, and refuses one that is not a whole number', async () => {
      const f = await make().fleet(pid(), { business: BUSINESS });
      assert.equal(f.rows.length, 3);
      await assert.rejects(make().fleet(pid(), { business: 0 }), (e: unknown) => e instanceof SettingsError && /business number/.test(e.message));
      await assert.rejects(make().fleet(pid(), { business: 1.5 }), (e: unknown) => e instanceof SettingsError);
    });
  });

  describe('the limits of aircraft types', () => {
    it('saves several at once, upper-cases the codes, and puts types back on the default', () => {
      h.store.setSafetyLimits(pid(), 'B738', { warn: 100, tier1: 200, tier2: 300 }, NOW);
      const done = make().setLimits(pid(), [
        { aircraft: ' a320 ', limits: { warn: 350, tier1: 450, tier2: 550 } },
        { aircraft: 'a20n', limits: { warn: 360, tier1: 460, tier2: 560 } },
        { aircraft: 'B738', limits: null },
        { aircraft: 'C172', limits: null },
      ]);
      assert.deepEqual(done, { set: 2, reset: 1 }, 'C172 had none of its own, so it is not counted');
      assert.deepEqual([...h.store.listSafetyLimits(pid())], [['A20N', { warn: 360, tier1: 460, tier2: 560 }], ['A320', { warn: 350, tier1: 450, tier2: 550 }]]);
    });

    it('refuses the whole list when one limit is wrong, and saves none of it', () => {
      h.store.setSafetyLimits(pid(), 'B738', { warn: 100, tier1: 200, tier2: 300 }, NOW);
      refused(
        () =>
          make().setLimits(pid(), [
            { aircraft: 'A320', limits: { warn: 350, tier1: 450, tier2: 550 } },
            { aircraft: 'B738', limits: null },
            { aircraft: 'C172', limits: { warn: 500, tier1: 400, tier2: 600 } },
          ]),
        /C172: The warning limit \(500\) can't be harder than the Tier 1 limit \(400\)/,
      );
      assert.deepEqual([...h.store.listSafetyLimits(pid()).keys()], ['B738'], 'neither the A320 nor the reset of the B738 happened');
    });

    it('refuses what is not an aircraft code, limits that are not whole numbers, and a limit above what a landing can be', () => {
      refused(() => make().setLimits(pid(), [{ aircraft: 'Boeing 737', limits: { warn: 1, tier1: 2, tier2: 3 } }]), /not an aircraft code/);
      refused(() => make().setLimits(pid(), [{ aircraft: '', limits: null }]), /not an aircraft code/);
      refused(() => make().setLimits(pid(), [{ aircraft: 'A320', limits: { warn: 350.5, tier1: 450, tier2: 550 } }]), /whole numbers of feet per minute/);
      refused(() => make().setLimits(pid(), [{ aircraft: 'A320', limits: { warn: null as unknown as number, tier1: 450, tier2: 550 } }]), /whole numbers of feet per minute/);
      refused(() => make().setLimits(pid(), [{ aircraft: 'A320', limits: { warn: 350, tier1: 450, tier2: 2501 } }]), /whole number of feet per minute from 1 to 2,500/);
      assert.equal(h.store.listSafetyLimits(pid()).size, 0);
    });

    it('is a setting of each airline', () => {
      const other = h.store.createPanel({ guildId: GUILD, name: 'Other Air', prefix: 'OTH', channelId: '9', now: T0 });
      make().setLimits(pid(), [{ aircraft: 'A320', limits: { warn: 350, tier1: 450, tier2: 550 } }]);
      assert.equal(h.store.listSafetyLimits(other.id).size, 0);
    });

    it('is the limits the pay is judged by: a landing is judged by its own aircraft\'s limits after they are saved here', () => {
      make().setSafety(pid(), { on: true });
      make().setLimits(pid(), [{ aircraft: 'A320', limits: { warn: 700, tier1: 800, tier2: 900 } }]);
      const policy = h.store.safetyPolicy(panel())!;
      assert.deepEqual(policy.byAircraft.get('A320'), { warn: 700, tier1: 800, tier2: 900 });
      assert.deepEqual(policy.defaults, { warn: 375, tier1: 400, tier2: 600 });
    });
  });
});

/* ------------------------------------------------------------------ the settings page's side */

describe('the airline settings on the setup page', () => {
  let dir: string;
  let paths: HostPaths;
  let h: Harness;
  let fshub: boolean;
  let supervisor: Supervisor;
  let web: WebServer;
  const pid = () => h.panel.id;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-airline-'));
    paths = hostPaths(dir);
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = true;
    h.store.updatePanel(pid(), { fshubAirlineId: AIRLINE, fshubConfirm: true });
    h.store.setKv(`aero.business.${AIRLINE}`, String(BUSINESS));
    const s = loadSettings(paths);
    s.discordToken = TOKEN;
    saveSettings(paths, s);
    supervisor = new Supervisor({
      paths,
      log: silentLogger,
      version: '9.9.9',
      onState: () => {},
      startBot: async () => ({ userTag: 'Bot#1', userId: BOT_ID, servers: () => [], settings: new AirlineSettings({ store: h.store, profits: profitsOf(h), fshub, now: () => h.clock.now }), stop: async () => {} }) as unknown as BotHandle,
    });
    const updates = new UpdateChecker({ version: '9.9.9', statePath: paths.updateState, autoEnabled: () => false, fetchFn: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch, repo: 'o/r' });
    web = await startWebServer({ supervisor, updates, paths, log: silentLogger, version: '9.9.9', key: KEY, tail: () => [], onQuit: () => {} });
  });
  afterEach(async () => {
    await web.close();
    await supervisor.stop();
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const url = (path: string, key: string | null = KEY) => `http://127.0.0.1:${web.port}${path}${key === null ? '' : `${path.includes('?') ? '&' : '?'}k=${key}`}`;
  const get = async (path: string) => {
    const r = await fetch(url(path));
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };

  it('has nothing to show while the bot is not running, and says why (409)', async () => {
    for (const path of ['/api/airlines', `/api/airline/safety?panel=${pid()}`, `/api/airline/fleet?panel=${pid()}`]) {
      const r = await get(path);
      assert.equal(r.status, 409, path);
      assert.match(r.body.error, /bot is not running/);
    }
    assert.equal((await post('/api/airline/safety', { panel: pid(), on: false })).status, 409);
  });

  it('is only for whoever has the key', async () => {
    await supervisor.start();
    for (const path of ['/api/airlines', `/api/airline/safety?panel=${pid()}`, `/api/airline/fleet?panel=${pid()}`]) {
      assert.equal((await fetch(url(path, null))).status, 403, path);
      assert.equal((await fetch(url(path, 'wrong'))).status, 403, path);
    }
    for (const path of ['/api/airline/safety', '/api/airline/limits']) {
      const r = await fetch(url(path, null), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ panel: pid() }) });
      assert.equal(r.status, 403, path);
    }
    const foreign = await fetch(url('/api/airline/safety'), { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ panel: pid(), on: false }) });
    assert.equal(foreign.status, 403, 'a page on another site cannot change them');
    assert.equal(h.store.getPanel(pid())!.safetyShareTier1, 8);
  });

  describe('with the bot running', () => {
    beforeEach(() => supervisor.start());

    it('lists the airlines', async () => {
      const r = await get('/api/airlines');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.airlines.map((a: any) => [a.id, a.name, a.safetyOn]), [[pid(), 'Test Air', false]]);
    });

    it('shows safety pay and the fleet of an airline, and refuses a missing, wrong or unknown airline', async () => {
      const safety = await get(`/api/airline/safety?panel=${pid()}`);
      assert.equal(safety.status, 200);
      assert.deepEqual([safety.body.on, safety.body.defaults, safety.body.shareTier1], [false, { warn: 375, tier1: 400, tier2: 600 }, 8]);
      const fleet = await get(`/api/airline/fleet?panel=${pid()}`);
      assert.deepEqual(fleet.body.rows.map((r: any) => [r.code, r.owned, r.leased, r.own]), [['A20N', 0, 1, false], ['A320', 2, 0, false], ['B738', 1, 0, false]]);
      for (const bad of ['', '?panel=', '?panel=abc', '?panel=0', '?panel=1.5', '?panel=-3']) {
        assert.equal((await get(`/api/airline/safety${bad}`)).status, 400, bad);
      }
      assert.equal((await get('/api/airline/safety?panel=999')).status, 404);
      assert.equal((await get('/api/airline/fleet?panel=999')).status, 404);
    });

    it('names a tab, not a Discord command, in the reason the fleet could not be read', async () => {
      h.store.updatePanel(pid(), { fshubAirlineId: null });
      const r = await get(`/api/airline/fleet?panel=${pid()}&refresh=1`);
      assert.equal(r.status, 200);
      assert.match(r.body.problem, /the \*\*FsHub roster\*\* tab/);
      assert.equal(/\/setup/.test(r.body.problem), false, r.body.problem);
    });

    it('reads the fleet again when asked, with the business number, and refuses a bad one', async () => {
      assert.equal((await get(`/api/airline/fleet?panel=${pid()}&refresh=1&business=${BUSINESS}`)).status, 200);
      const bad = await get(`/api/airline/fleet?panel=${pid()}&business=abc`);
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /business number/);
    });

    it('saves safety pay: on, the shares, what is lost, deductions and the default limits, and answers with how it now stands', async () => {
      const r = await post('/api/airline/safety', { panel: pid(), on: true, shareTier1: 10, shareTier2: 6, lossTier1: 10, lossTier2: 40, deductions: true, defaults: { warn: 450, tier1: 550, tier2: 650 } });
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.on, r.body.since, r.body.shareTier1, r.body.shareTier2, r.body.lossTier1, r.body.lossTier2, r.body.deductions, r.body.defaults], [true, NOW, 10, 6, 10, 40, true, { warn: 450, tier1: 550, tier2: 650 }]);
      const p = h.store.getPanel(pid())!;
      assert.deepEqual([p.safetyPaySince, p.safetyShareTier1, p.safetyLossTier2, p.safetyDeductions, p.safetyTier2Fpm], [NOW, 10, 40, true, 650]);
    });

    it('says what is wrong, in words, and saves nothing, when a setting is refused', async () => {
      const limits = await post('/api/airline/safety', { panel: pid(), shareTier1: 12, defaults: { warn: 600, tier1: 500, tier2: 700 } });
      assert.equal(limits.status, 400);
      assert.match(limits.body.error, /warning limit \(600\) can't be harder than the Tier 1 limit \(500\)/);
      const pct = await post('/api/airline/safety', { panel: pid(), lossTier1: 150 });
      assert.equal(pct.status, 400);
      assert.match(pct.body.error, /whole number of per cent, from 0 to 100/);
      const shape = await post('/api/airline/safety', { panel: pid(), defaults: { warn: '400', tier1: 500, tier2: 600 } });
      assert.equal(shape.status, 400);
      assert.match(shape.body.error, /three numbers/);
      assert.equal((await post('/api/airline/safety', { panel: 'x' })).status, 400);
      assert.equal((await post('/api/airline/safety', { panel: 999, on: false })).status, 404);
      assert.equal(h.store.getPanel(pid())!.safetyShareTier1, 8);
      fshub = false;
      await supervisor.restart();
      const noFsHub = await post('/api/airline/safety', { panel: pid(), on: true });
      assert.equal(noFsHub.status, 400);
      assert.match(noFsHub.body.error, /no FsHub token/);
      assert.equal(h.store.getPanel(pid())!.safetyPaySince, null);
    });

    it('saves the limits of aircraft types, and puts one back on the default', async () => {
      const set = await post('/api/airline/limits', { panel: pid(), changes: [{ aircraft: 'a320', limits: { warn: 350, tier1: 450, tier2: 550 } }, { aircraft: 'B738', limits: { warn: 700, tier1: 800, tier2: 900 } }] });
      assert.deepEqual([set.status, set.body.set, set.body.reset], [200, 2, 0]);
      assert.deepEqual([...h.store.listSafetyLimits(pid()).keys()], ['A320', 'B738']);
      const fleet = await get(`/api/airline/fleet?panel=${pid()}`);
      assert.deepEqual(fleet.body.rows.find((r: any) => r.code === 'A320').limits, { warn: 350, tier1: 450, tier2: 550 });
      const reset = await post('/api/airline/limits', { panel: pid(), changes: [{ aircraft: 'A320', limits: null }] });
      assert.deepEqual([reset.body.set, reset.body.reset], [0, 1]);
      assert.deepEqual([...h.store.listSafetyLimits(pid()).keys()], ['B738']);
    });

    it('refuses a list with one bad aircraft, saying which, and saves none of it', async () => {
      const r = await post('/api/airline/limits', { panel: pid(), changes: [{ aircraft: 'A320', limits: { warn: 350, tier1: 450, tier2: 550 } }, { aircraft: 'C172', limits: { warn: 500, tier1: 400, tier2: 600 } }] });
      assert.equal(r.status, 400);
      assert.match(r.body.error, /C172: The warning limit \(500\)/);
      assert.equal(h.store.listSafetyLimits(pid()).size, 0);
      for (const body of [{ panel: pid() }, { panel: pid(), changes: 'A320' }, { panel: pid(), changes: [{ limits: null }] }, { panel: pid(), changes: [null] }, { panel: pid(), changes: [{ aircraft: 'A320', limits: { warn: 350 } }] }, { panel: pid(), changes: [{ aircraft: 'A320' }] }]) {
        assert.equal((await post('/api/airline/limits', body)).status, 400, JSON.stringify(body));
      }
      assert.equal(h.store.listSafetyLimits(pid()).size, 0);
    });
  });

  describe('the page', () => {
    const html = renderPage('1.0.0');
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1] as string;

    it('has the airline settings section, with no markup built from text (nothing from Aeroconomy or FsHub can inject any)', () => {
      assert.match(html, /id="s-airline"/);
      assert.match(html, /<h2>Landing safety<\/h2>/);
      assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), false);
    });

    it('is a script that parses', () => {
      assert.doesNotThrow(() => new Function(script));
    });

    it('has every element its script looks for', () => {
      const wanted = new Set([...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1] as string));
      assert.ok(wanted.has('pick-airline') && wanted.has('pick-server') && wanted.has('cmd-run') && wanted.has('sf-save') && wanted.has('fleet-save'), 'it looks for the new ones too');
      const missing = [...wanted].filter((id) => !html.includes(`id="${id}"`));
      assert.deepEqual(missing, []);
    });

    it('has a field for each of the three default limits, the shares, and what is lost of the minimum', () => {
      for (const id of ['sf-on', 'sf-warn', 'sf-t1', 'sf-t2', 'sf-s1', 'sf-s2', 'sf-l1', 'sf-l2', 'sf-ded', 'fleet-body', 'fleet-add', 'fleet-business']) assert.match(html, new RegExp(`id="${id}"`), id);
    });
  });
});
