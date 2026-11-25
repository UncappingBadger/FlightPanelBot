import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AeroconomyError } from '../src/aeroconomy/http.js';
import { MIGRATIONS } from '../src/db/db.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { AirlineProfits, ProfitError } from '../src/services/airlineProfits.js';
import { parseFpm, readFleet, type LimitsDeps } from '../src/services/safetyLimits.js';
import { GUILD, HOUR, T0, makeHarness, type Harness } from './helpers.js';

const NOW = T0 + 6 * HOUR;
const AIRLINE = 4242;
const BUSINESS = 77;

/* ------------------------------------------------------------------ what is kept */

describe('landing limits in the database', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('starts a new panel at 400, 500 and 600, paying 8% and 5%, with nothing lost of the minimum', () => {
    const p = h.store.createPanel({ guildId: GUILD, name: 'Fresh Air', prefix: 'FRS', channelId: '9', now: T0 });
    assert.deepEqual([p.safetyWarnFpm, p.safetyTier1Fpm, p.safetyTier2Fpm], [400, 500, 600]);
    assert.deepEqual([p.safetyShareTier1, p.safetyShareTier2], [8, 5]);
    assert.deepEqual([p.safetyLossTier1, p.safetyLossTier2, p.safetyPaySince], [0, 0, null]);
  });

  it('keeps the limits and shares an airline sets, whole numbers, and the percentages between 0 and 100', () => {
    h.store.updatePanel(h.panel.id, { safetyWarnFpm: 350.4, safetyTier1Fpm: 450, safetyTier2Fpm: 550, safetyShareTier1: 150, safetyShareTier2: -4, safetyLossTier1: 12.6, safetyLossTier2: 200 });
    const p = h.store.getPanel(h.panel.id)!;
    assert.deepEqual([p.safetyWarnFpm, p.safetyTier1Fpm, p.safetyTier2Fpm], [350, 450, 550]);
    assert.deepEqual([p.safetyShareTier1, p.safetyShareTier2, p.safetyLossTier1, p.safetyLossTier2], [100, 0, 13, 100]);
  });

  it('gives an aircraft limits of its own, in upper case, changes them, and takes them away again', () => {
    assert.equal(h.store.listSafetyLimits(h.panel.id).size, 0);
    h.store.setSafetyLimits(h.panel.id, ' a320 ', { warn: 350, tier1: 450, tier2: 550 }, T0);
    h.store.setSafetyLimits(h.panel.id, 'B748', { warn: 700, tier1: 850, tier2: 1000 }, T0);
    assert.deepEqual([...h.store.listSafetyLimits(h.panel.id)], [['A320', { warn: 350, tier1: 450, tier2: 550 }], ['B748', { warn: 700, tier1: 850, tier2: 1000 }]]);
    h.store.setSafetyLimits(h.panel.id, 'A320', { warn: 360, tier1: 460, tier2: 560 }, T0 + 1);
    assert.deepEqual(h.store.listSafetyLimits(h.panel.id).get('A320'), { warn: 360, tier1: 460, tier2: 560 });
    assert.equal(h.store.clearSafetyLimits(h.panel.id, 'a320'), true);
    assert.equal(h.store.clearSafetyLimits(h.panel.id, 'A320'), false, 'nothing left to take away');
    assert.deepEqual([...h.store.listSafetyLimits(h.panel.id).keys()], ['B748']);
  });

  it('keeps each panel\'s aircraft apart, and forgets them with the panel', () => {
    const other = h.store.createPanel({ guildId: GUILD, name: 'Other Air', prefix: 'OTH', channelId: '9', now: T0 });
    h.store.setSafetyLimits(h.panel.id, 'A320', { warn: 350, tier1: 450, tier2: 550 }, T0);
    h.store.setSafetyLimits(other.id, 'A320', { warn: 800, tier1: 900, tier2: 1000 }, T0);
    assert.equal(h.store.listSafetyLimits(h.panel.id).get('A320')!.warn, 350);
    assert.equal(h.store.listSafetyLimits(other.id).get('A320')!.warn, 800);
    h.store.deletePanel(other.id);
    assert.equal(h.store.listSafetyLimits(other.id).size, 0);
    assert.equal(h.store.listSafetyLimits(h.panel.id).size, 1);
  });

  it('gives the policy of a panel with its aircraft in it, and nothing while safety pay is off', () => {
    h.store.setSafetyLimits(h.panel.id, 'A320', { warn: 350, tier1: 450, tier2: 550 }, T0);
    assert.equal(h.store.safetyPolicy(h.store.getPanel(h.panel.id)!), null);
    h.store.updatePanel(h.panel.id, { safetyPaySince: 5, safetyShareTier1: 10 });
    const policy = h.store.safetyPolicy(h.store.getPanel(h.panel.id)!)!;
    assert.deepEqual(policy.defaults, { warn: 375, tier1: 400, tier2: 600 });
    assert.equal(policy.shareTier1, 10);
    assert.deepEqual(policy.byAircraft.get('A320'), { warn: 350, tier1: 450, tier2: 550 });
  });

  it('knows which types the airline\'s recent flights were flown in', () => {
    const flight = (id: number, icao: string | null) => ({ flightId: id, pilotId: 1, pilotName: 'x', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - HOUR, arrivedAt: NOW, aircraftIcao: icao, aircraftName: null, scheduleStatus: null });
    h.store.upsertFshubFlights(h.panel.id, [flight(1, 'b738'), flight(2, 'A320'), flight(3, 'A320'), flight(4, null)]);
    assert.deepEqual(h.store.listFlownAircraftTypes(h.panel.id), ['A320', 'B738']);
  });

  describe('when an older database is brought up to date', () => {
    const step = MIGRATIONS.findIndex((m) => m.includes('safety_warn_fpm'));
    it('keeps what an airline with safety pay on had (375, 400 and 600), starts one with it off at 400, 500 and 600, and carries the percentages across', () => {
      assert.ok(step > 0, 'the step exists');
      const old = new DatabaseSync(':memory:');
      for (let v = 0; v < step; v++) old.exec(MIGRATIONS[v] as string);
      const add = old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at, safety_pay_since, safety_loss_tier2, safety_loss_tier3) VALUES (?, ?, ?, ?, 'c', 1, ?, ?, ?)`);
      add.run('g', 1, 'On Air', 'ONN', 1234, 10, 40);
      add.run('g', 2, 'Off Air', 'OFF', null, 5, 6);
      old.exec(MIGRATIONS[step] as string);
      const rows = old.prepare('SELECT prefix, safety_warn_fpm AS w, safety_tier1_fpm AS a, safety_tier2_fpm AS b, safety_share_tier1 AS s1, safety_share_tier2 AS s2, safety_loss_t1 AS l1, safety_loss_t2 AS l2 FROM panels ORDER BY id').all() as Array<Record<string, unknown>>;
      assert.deepEqual(rows.map((r) => [r.prefix, r.w, r.a, r.b, r.s1, r.s2, r.l1, r.l2]), [
        ['ONN', 375, 400, 600, 8, 5, 10, 40],
        ['OFF', 400, 500, 600, 8, 5, 5, 6],
      ]);
      assert.equal((old.prepare('SELECT count(*) AS c FROM safety_limits').get() as { c: number }).c, 0);
    });
  });
});

/* ------------------------------------------------------------------ the fleet */

describe('the fleet of an airline', () => {
  let h: Harness;
  /** What the bot reads the airline's aircraft with (none when it has no FsHub token). */
  let live: AirlineProfits | null;
  const deps = (): LimitsDeps => ({ store: h.store, profits: live, now: () => h.clock.now });
  let owned: Array<Record<string, unknown>>;
  let leased: Array<Record<string, unknown>> | Error;
  let ownedError: Error | null;
  let calls: number;
  const plane = (serial: number, type: string | null) => ({ serial, registration: `G-${serial}`, type, ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: BUSINESS });
  const profits = () =>
    new AirlineProfits({
      store: h.store,
      account: {
        ownedAircraft: async () => {
          calls++;
          if (ownedError) throw ownedError;
          return owned as never;
        },
        leasedAircraft: async () => {
          if (leased instanceof Error) throw leased;
          return leased as never;
        },
        aircraft: async () => null,
        logbook: async () => [],
      },
      publicClient: { pilotAircraftOwner: async () => ({ airlineId: AIRLINE, businessId: BUSINESS }) },
      now: () => h.clock.now,
    });

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE, fshubConfirm: true });
    h.store.setKv(`aero.business.${AIRLINE}`, String(BUSINESS));
    owned = [plane(1, 'A320'), plane(2, 'a320'), plane(3, 'B738')];
    leased = [{ ...plane(10, 'A20N'), ownerType: 'airline', ownerAirlineId: 999, pilotAirlineId: AIRLINE }, plane(11, 'B738'), plane(2, 'A320')];
    ownedError = null;
    calls = 0;
    live = profits();
  });
  afterEach(async () => {
    await h.close();
  });

  it('counts the aircraft the airline owns and the ones it leases, by type, each leased aircraft once', async () => {
    const fleet = await profits().fleetTypes(h.store.getPanel(h.panel.id)!);
    assert.deepEqual([...fleet.types].sort(), [['A20N', { owned: 0, leased: 1 }], ['A320', { owned: 2, leased: 0 }], ['B738', { owned: 1, leased: 1 }]]);
    assert.equal(fleet.problem, null);
    assert.equal(fleet.businessId, BUSINESS);
  });

  it('counts an aircraft with no type apart, and leaves it out of the types', async () => {
    owned.push(plane(4, null), plane(5, 'Boeing 737'));
    const fleet = await profits().fleetTypes(h.store.getPanel(h.panel.id)!);
    assert.equal(fleet.untyped, 2);
    assert.deepEqual([...fleet.types.keys()].sort(), ['A20N', 'A320', 'B738']);
  });

  it('still gives the owned aircraft when the list of leased ones cannot be read, and says why', async () => {
    leased = new AeroconomyError('Aeroconomy answered 500.', 500);
    const fleet = await profits().fleetTypes(h.store.getPanel(h.panel.id)!);
    assert.deepEqual([...fleet.types.keys()].sort(), ['A320', 'B738']);
    assert.match(fleet.problem ?? '', /Aeroconomy answered 500/);
  });

  it('takes the airline\'s business number when it is given, checks it is the airline\'s, and remembers it', async () => {
    h.store.setKv(`aero.business.${AIRLINE}`, '0');
    const panel = h.store.getPanel(h.panel.id)!;
    const fleet = await profits().fleetTypes(panel, 123);
    assert.equal(fleet.businessId, 123);
    assert.equal(h.store.getKv(`aero.business.${AIRLINE}`), '123');
    owned = [{ ...plane(1, 'A320'), ownerAirlineId: 1 }];
    await assert.rejects(profits().fleetTypes(panel, 456), /isn't this airline's/);
    assert.equal(h.store.getKv(`aero.business.${AIRLINE}`), '123', 'a business that is not the airline\'s is not remembered');
  });

  it('needs the panel linked to its airline\'s FsHub roster', async () => {
    h.store.updatePanel(h.panel.id, { fshubAirlineId: null });
    await assert.rejects(profits().fleetTypes(h.store.getPanel(h.panel.id)!), (e: unknown) => e instanceof ProfitError && /isn't linked to its airline's FsHub roster/.test(e.message));
  });

  it('is read once for a while: the questions of a walk through the fleet do not each ask Aeroconomy', async () => {
    const panel = h.store.getPanel(h.panel.id)!;
    const first = await readFleet(deps(), panel, true);
    assert.deepEqual(first.entries.map((e) => [e.code, e.owned, e.leased]), [['A20N', 0, 1], ['A320', 2, 0], ['B738', 1, 1]]);
    assert.equal(calls, 1);
    await readFleet(deps(), panel, false);
    await readFleet(deps(), panel, false);
    assert.equal(calls, 1, 'the read of a moment ago was used');
    h.clock.now += 61 * 60_000;
    await readFleet(deps(), panel, false);
    assert.equal(calls, 2, 'an hour later it is read again');
    await readFleet(deps(), panel, true);
    assert.equal(calls, 3, 'and on request');
  });

  it('adds the types the airline\'s flights were flown in and the types that have limits of their own, which are not in the fleet list', async () => {
    h.store.upsertFshubFlights(h.panel.id, [{ flightId: 1, pilotId: 1, pilotName: 'x', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - HOUR, arrivedAt: NOW, aircraftIcao: 'C172', aircraftName: null, scheduleStatus: null }]);
    h.store.setSafetyLimits(h.panel.id, 'DH8D', { warn: 300, tier1: 400, tier2: 500 }, NOW);
    const fleet = await readFleet(deps(), h.store.getPanel(h.panel.id)!, true);
    assert.deepEqual(fleet.entries.map((e) => [e.code, e.owned + e.leased, e.flown]), [['A20N', 1, false], ['A320', 2, false], ['B738', 2, false], ['C172', 0, true], ['DH8D', 0, false]]);
  });

  it('says why when Aeroconomy cannot be asked, and lists the types the flights were flown in', async () => {
    h.store.upsertFshubFlights(h.panel.id, [{ flightId: 1, pilotId: 1, pilotName: 'x', dep: 'EGLL', arr: 'EGKK', departedAt: NOW - HOUR, arrivedAt: NOW, aircraftIcao: 'C172', aircraftName: null, scheduleStatus: null }]);
    ownedError = new AeroconomyError('Aeroconomy is down.', 503);
    const fleet = await readFleet(deps(), h.store.getPanel(h.panel.id)!, true);
    assert.match(fleet.problem ?? '', /would not list the airline's aircraft \(Aeroconomy is down\.\)/);
    assert.deepEqual(fleet.entries.map((e) => e.code), ['C172']);
    live = null;
    const none = await readFleet(deps(), h.store.getPanel(h.panel.id)!, true);
    assert.match(none.problem ?? '', /no FsHub token/);
  });
});


/* ------------------------------------------------------------------ typed numbers */

describe('reading limits', () => {
  it('reads whole numbers of feet per minute as they are typed: 450, -450, 450 fpm', () => {
    assert.deepEqual(['450', '-450', ' 450 fpm', '−450', '450fpm', '1,200', '12.5', '', 'abc', '450 450', '123456'].map(parseFpm), [450, 450, 450, 450, 450, null, null, null, null, null, null]);
  });
});

/* ------------------------------------------------------------------ what Discord keeps */

describe('the slash commands', () => {
  it('no longer have /safety-limits: the limits are set on the host\'s settings page, not in Discord', () => {
    assert.equal(commands.some((c) => c.data.name === 'safety-limits'), false);
    assert.equal(componentHandlers.some((c) => c.prefix === 'slimits'), false);
  });

  it('leave every command within what Discord allows: 25 subcommands, 8,000 characters, 100 in a description', () => {
    const size = (o: any): number => {
      let n = 0;
      for (const k of ['name', 'description']) if (typeof o[k] === 'string') n += o[k].length;
      if (typeof o.value === 'string') n += o.value.length;
      for (const c of o.choices ?? []) n += size(c);
      for (const c of o.options ?? []) n += size(c);
      return n;
    };
    const tooLong = (o: any): string[] => [...(typeof o.description === 'string' && o.description.length > 100 ? [`${o.name}: ${o.description.length}`] : []), ...(o.options ?? []).flatMap(tooLong), ...(o.choices ?? []).flatMap(tooLong)];
    for (const c of commands) {
      const j = c.data.toJSON() as any;
      assert.ok(size(j) <= 8000, `/${j.name} is ${size(j)} characters`);
      assert.ok((j.options ?? []).filter((o: any) => o.type === 1 || o.type === 2).length <= 25, `/${j.name} has too many subcommands`);
      assert.deepEqual(tooLong(j), [], `/${j.name} has a description over 100 characters`);
    }
  });
});

void [HOUR];
