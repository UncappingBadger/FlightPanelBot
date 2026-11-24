import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MIGRATIONS } from '../src/db/db.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { safetyStatus } from '../src/discord/safetyUi.js';
import { payAmount } from '../src/services/payroll.js';
import { pilotPay } from '../src/services/pilotPay.js';
import { fineFor, fineShare, IMPLAUSIBLE_FPM, lossForTier, readLanding, safetyNotice, safetyPolicyOf } from '../src/services/safetyPay.js';
import { HOUR, T0, USER_A, makeHarness, type Harness } from './helpers.js';
import { fakeComponent, fakeInteraction, FakeFsHub, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;
const NOW = T0 + 6 * HOUR;
const setup = commands.find((c) => c.data.name === 'setup')!;
const handler = componentHandlers.find((c) => c.prefix === 'safety')!;

/* ------------------------------------------------------------------ the tiers */

describe('how hard a landing is, in the airline\'s tiers', () => {
  it('has Tier 1 from 375 feet per minute, Tier 2 from 400 and Tier 3 from 600, each limit counted in the harder tier', () => {
    const tier = (rate: number) => (readLanding(rate) as { tier: number | null }).tier;
    assert.equal(tier(-374), null);
    assert.equal(tier(-375), 1);
    assert.equal(tier(-399), 1);
    assert.equal(tier(-400), 2);
    assert.equal(tier(-599), 2);
    assert.equal(tier(-600), 3);
    assert.equal(tier(-2500), 3, 'the top of what is believed is still a landing');
  });

  it('reads the rate as feet per minute without its sign, and rounds a rate with a fraction to the nearest', () => {
    assert.deepEqual(readLanding(-450), { kind: 'ok', fpm: 450, tier: 2 });
    assert.deepEqual(readLanding(-399.6), { kind: 'ok', fpm: 400, tier: 2 });
    assert.deepEqual(readLanding(-374.4), { kind: 'ok', fpm: 374, tier: null });
  });

  it('is no reading when FsHub gave none or gave something that is not a descent, and not believed beyond 2,500', () => {
    for (const rate of [null, undefined, Number.NaN, Infinity, 0, 300, 1200]) assert.deepEqual(readLanding(rate), { kind: 'none' }, String(rate));
    assert.deepEqual(readLanding(-(IMPLAUSIBLE_FPM + 1)), { kind: 'unreliable', fpm: IMPLAUSIBLE_FPM + 1 });
    assert.deepEqual(readLanding(-10_000), { kind: 'unreliable', fpm: 10_000 });
  });

  it('pays 8% after a Tier 2 landing and 5% after a Tier 3', () => {
    assert.deepEqual([fineShare(2), fineShare(3)], [8, 5]);
  });

  it('fines only a Tier 2 or Tier 3 landing that came after safety pay was turned on, carrying the airline\'s percentage', () => {
    const policy = { since: 1000, lossTier2: 25, lossTier3: 25 };
    assert.deepEqual(fineFor(readLanding(-450), 2000, policy), { tier: 2, fpm: 450, minimumLoss: 25 });
    assert.deepEqual(fineFor(readLanding(-650), 1000, { since: 1000, lossTier2: 0, lossTier3: 0 }), { tier: 3, fpm: 650, minimumLoss: 0 }, 'at the moment it was turned on counts');
    assert.equal(fineFor(readLanding(-450), 999, policy), null, 'before it was turned on');
    assert.equal(fineFor(readLanding(-390), 2000, policy), null, 'Tier 1 is a warning only');
    assert.equal(fineFor(readLanding(-100), 2000, policy), null);
    assert.equal(fineFor(readLanding(null), 2000, policy), null);
    assert.equal(fineFor(readLanding(-9000), 2000, policy), null);
    assert.equal(fineFor(readLanding(-450), 2000, null), null, 'and none when it is off');
  });

  it('takes the policy from a panel, null while it is off', () => {
    assert.equal(safetyPolicyOf({ safetyPaySince: null, safetyLossTier2: 0, safetyLossTier3: 0 }), null);
    assert.deepEqual(safetyPolicyOf({ safetyPaySince: 5, safetyLossTier2: 10, safetyLossTier3: 40 }), { since: 5, lossTier2: 10, lossTier3: 40 });
  });

  it('gives each tier its own percentage when the airline set them apart, and nothing for a Tier 1 warning', () => {
    const split = { since: 1000, lossTier2: 10, lossTier3: 40 };
    assert.deepEqual([lossForTier(split, 1), lossForTier(split, 2), lossForTier(split, 3)], [0, 10, 40]);
    assert.deepEqual(fineFor(readLanding(-450), 2000, split), { tier: 2, fpm: 450, minimumLoss: 10 });
    assert.deepEqual(fineFor(readLanding(-650), 2000, split), { tier: 3, fpm: 650, minimumLoss: 40 });
  });
});

/* ------------------------------------------------------------------ the pay */

describe('the pay after a hard landing', () => {
  const pay = (profit: number, nm: number | null, tier: 2 | 3, minimumLoss: number) => pilotPay(profit, nm, { tier, minimumLoss });

  it('is 8% of the profit for Tier 2 and 5% for Tier 3, rounded up to the next whole dollar, with the usual pay noted', () => {
    assert.deepEqual(pay(54204, null, 2, 0), { amount: 4337, basis: 'safety', safety: { tier: 2, share: 8, normal: 8131, minimumLoss: 0, byMinimum: false } }, '8% of $54,204 is $4,336.32');
    assert.deepEqual(pay(54204, null, 3, 0), { amount: 2711, basis: 'safety', safety: { tier: 3, share: 5, normal: 8131, minimumLoss: 0, byMinimum: false } }, '5% is $2,710.20');
    assert.equal(pay(50000, null, 2, 0)!.amount, 4000, 'a share that comes out even stays as it is');
  });

  it('never goes below the minimum after the percentage the airline takes off it: $2,000 less that per cent', () => {
    assert.equal(pay(10000, null, 2, 0)!.amount, 2000, '8% of $10,000 is $800, but the whole minimum is kept');
    assert.equal(pay(10000, null, 2, 25)!.amount, 1500, 'a quarter of the $2,000 is lost');
    assert.equal(pay(10000, null, 2, 50)!.amount, 1000);
    assert.equal(pay(10000, null, 3, 50)!.amount, 1000, 'the same percentage for Tier 3: $500 is the share, $1,000 is the floor');
    assert.equal(pay(10000, null, 2, 10)!.amount, 1800);
    assert.equal(pay(10000, null, 2, 33)!.amount, 1340, '$2,000 less 33% is $1,340');
    assert.equal(pay(10000, null, 2, 100)!.amount, 800, 'with all of it lost there is no minimum: just the share');
    assert.equal(pay(10000, null, 3, 100)!.amount, 500);
  });

  it('says when it was the minimum that decided the pay, and when it was the share', () => {
    assert.equal(pay(10000, null, 2, 25)!.safety!.byMinimum, true);
    assert.equal(pay(10000, null, 2, 100)!.safety!.byMinimum, false);
    assert.equal(pay(30000, null, 2, 0)!.safety!.byMinimum, false, '8% of $30,000 is $2,400, above the minimum');
    assert.equal(pay(30000, null, 3, 0)!.safety!.byMinimum, true, '5% of $30,000 is $1,500, below it');
    assert.equal(pay(30000, null, 3, 0)!.amount, 2000);
    assert.equal(pay(30000, null, 3, 25)!.amount, 1500, 'the share and the floor are the same: the share decides');
    assert.equal(pay(30000, null, 3, 25)!.safety!.byMinimum, false);
  });

  it('is nothing for a flight that made no profit where the whole minimum is lost, and the minimum less the loss otherwise', () => {
    assert.equal(pay(0, null, 2, 100)!.amount, 0);
    assert.equal(pay(0, null, 3, 0)!.amount, 2000);
    assert.equal(pay(0, null, 3, 20)!.amount, 1600);
  });

  it('takes the percentage off the usual distance pay of a flight that lost money, whichever the tier, rounded up', () => {
    assert.deepEqual(pay(-8000, 1502, 2, 25), { amount: 3000, basis: 'safety', safety: { tier: 2, share: 8, normal: 4000, minimumLoss: 25, byMinimum: false } }, '$4,000 less 25%');
    assert.equal(pay(-8000, 1502, 3, 25)!.amount, 3000);
    assert.equal(pay(-8000, 1502, 2, 0)!.amount, 4000, 'with nothing lost it is the usual pay');
    assert.equal(pay(-8000, 1502, 2, 10)!.amount, 3600);
    assert.equal(pay(-8000, 1502, 2, 100)!.amount, 0, 'all of it lost: nothing');
    assert.equal(pay(-8000, 2500, 3, 33)!.amount, 3350, '2,500 nm pays $5,000 normally: 5000 x 67% = 3350');
    assert.equal(pay(-8000, 1001, 2, 33)!.amount, 2010, '$3,000 x 67%');
    assert.equal(pay(-8000, 500, 2, 7)!.amount, 1860, '$2,000 x 93%');
    assert.equal(pay(-8000, 1502, 2, 33)!.amount, 2680, '$4,000 x 67%');
  });

  it('still needs the distance of a flight that lost money, and is the usual pay when there is no fine', () => {
    assert.equal(pay(-8000, null, 2, 0), null);
    assert.deepEqual(pilotPay(54489, null, null), { amount: 8174, basis: 'share' });
    assert.deepEqual(pilotPay(54489, null), { amount: 8174, basis: 'share' });
    assert.equal(pay(Number.NaN, null, 2, 0), null);
  });

  it('treats a percentage out of range as the nearest end', () => {
    assert.equal(pay(10000, null, 2, -5)!.amount, 2000);
    assert.equal(pay(10000, null, 2, 150)!.amount, 800);
  });
});

/* ------------------------------------------------------------------ the message */

describe('the safety notice', () => {
  const subject = { fpm: 452, route: 'EGLL → EGKK', airline: 'Test Air', minimumLoss: 0 };

  it('says the warning in the CEO\'s words for Tier 1, with no fine', () => {
    const text = safetyNotice({ ...subject, tier: 1 });
    assert.match(text, /^⚠️ \*\*Tier 1 Safety Warning\*\*\nEGLL → EGKK · landing rate \*\*-452 fpm\*\* · Test Air\n\n/);
    assert.match(text, /ACCEPTABLE LEVEL of additional stress placed on the aircraft due to a HARD LANDING\. There are no safety fines for landing between -375 and -399, however landing rates above -400fpm will incur safety fines to offset aircraft damage costs and poor customer service ratings\./);
    assert.doesNotMatch(text, /minimum/);
  });

  it('says the 8% for Tier 2 and the 5% for Tier 3, in the CEO\'s words', () => {
    const t2 = safetyNotice({ ...subject, tier: 2 });
    assert.match(t2, /^🚨 \*\*Tier 2 Safety Violation\*\*/);
    assert.match(t2, /EXCESSIVE STRESS placed on the aircraft due to a HARD LANDING between -400 and -599fpm\. Due to this safety violation, you will receive only 8% of this flight's profits as a safety fine/);
    const t3 = safetyNotice({ ...subject, tier: 3 });
    assert.match(t3, /^🛑 \*\*Tier 3 Critical Safety Violation\*\*/);
    assert.match(t3, /DANGEROUS AND EXTREME STRESS being placed on the aircraft due to an EXTREMELY HARD LANDING above -600fpm\. Due to this safety violation, you will receive only 5% of this flight's profits as a safety fine imposed to offset the increased damage and the cost of decreased customer satisfaction caused by this landing\./);
  });

  it('says what the airline takes off the $2,000 minimum pay: nothing, a per cent, or all of it', () => {
    assert.match(safetyNotice({ ...subject, tier: 2, minimumLoss: 0 }), /The airline's \$2,000 minimum pay still applies to this flight\./);
    assert.match(safetyNotice({ ...subject, tier: 2, minimumLoss: 25 }), /The airline's safety rule takes 25% off the \$2,000 minimum pay, and off the distance pay of a flight that lost money\./);
    assert.match(safetyNotice({ ...subject, tier: 3, minimumLoss: 100 }), /takes all of the \$2,000 minimum pay: this flight pays only the share above, and a flight that lost money pays nothing\./);
    assert.doesNotMatch(safetyNotice({ ...subject, tier: 1, minimumLoss: 25 }), /minimum/, 'a warning has no fine to talk about');
  });

  it('has no typo, and fits in a message with a long airline name', () => {
    for (const tier of [1, 2, 3] as const) {
      const text = safetyNotice({ ...subject, tier, airline: 'A'.repeat(60) });
      assert.doesNotMatch(text, /landign/);
      assert.ok(text.length < 1900, `${text.length}`);
    }
  });
});

/* ------------------------------------------------------------------ turning it on and off */

describe('/setup safety-pay', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  const pid = () => h.panel.id;
  const panel = () => h.store.getPanel(pid())!;
  const run = async (options: Record<string, unknown> = {}, admin = true) => {
    const f = fakeInteraction({ sub: 'safety-pay', admin, options });
    await setup.execute(d.ctx, f.i);
    return f.calls;
  };
  const text = (calls: { edits: Array<{ content?: string }> }) => String(calls.edits.at(-1)?.content ?? '');
  const buttons = (calls: { edits: any[] }) => (calls.edits.at(-1)?.components ?? []).flatMap((r: any) => r.toJSON().components) as Array<{ custom_id: string; label: string }>;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    d = makeDiscordHarness(h, { fshub: new FakeFsHub() });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    h.store.updatePanel(pid(), { fshubAirlineId: 4242, fshubConfirm: true });
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });

  it('is one of the subcommands, with a whole number from 0 to 100 for the per cent lost, for both tiers or for each', () => {
    const j = setup.data.toJSON();
    const sub = (j.options as any[]).find((o) => o.name === 'safety-pay');
    assert.ok(sub, 'it exists');
    assert.deepEqual(sub.options.map((o: any) => o.name), ['mode', 'minimum-loss', 'tier2-loss', 'tier3-loss', 'deductions', 'airline']);
    for (const name of ['minimum-loss', 'tier2-loss', 'tier3-loss']) {
      const loss = sub.options.find((o: any) => o.name === name);
      assert.deepEqual([loss.min_value, loss.max_value], [0, 100], name);
    }
  });

  it('leaves /setup within the 8,000 characters Discord allows for a command, and each option description within 100', () => {
    /** Discord counts the name, description and value of the command, its subcommands, options and choices. */
    const size = (o: any): number => {
      let n = 0;
      for (const k of ['name', 'description']) if (typeof o[k] === 'string') n += o[k].length;
      if (typeof o.value === 'string') n += o.value.length;
      for (const c of o.choices ?? []) n += size(c);
      for (const c of o.options ?? []) n += size(c);
      return n;
    };
    const j = setup.data.toJSON() as any;
    assert.ok(size(j) <= 8000, `/setup is ${size(j)} characters`);
    const sub = (j.options as any[]).find((o) => o.name === 'safety-pay');
    for (const o of sub.options) assert.ok(o.description.length <= 100, `${o.name}: ${o.description.length}`);
  });

  it('is refused to anyone who is not a server admin', async () => {
    await assert.rejects(run({ mode: 'on', 'minimum-loss': 0 }, false), /Only server admins/);
    assert.equal(panel().safetyPaySince, null);
  });

  it('says it is off when nothing has been asked, and that turning it on asks what per cent of the minimum a pilot loses', async () => {
    const t = text(await run());
    assert.match(t, /Landing safety pay is \*\*off\*\*/);
    assert.match(t, /I will ask what percentage of the \$2,000 minimum pay a pilot loses first/);
    assert.equal(panel().safetyPaySince, null);
  });

  it('asks what percentage of the $2,000 minimum a pilot loses when turned on without an answer, with buttons, and changes nothing yet', async () => {
    const calls = await run({ mode: 'on' });
    assert.match(text(calls), /\*\*Turn on landing safety pay for Test Air\?\*\* One question first\./);
    assert.match(text(calls), /what percentage of that pay should they lose\?/);
    assert.match(text(calls), /\*\*0%:\*\* they keep the whole minimum/);
    assert.match(text(calls), /no less than \$1,500\. \*\*50%:\*\* no less than \$1,000/);
    assert.match(text(calls), /\*\*100%:\*\* there is no minimum/);
    assert.match(text(calls), /`\/setup safety-pay mode:on minimum-loss:15`/);
    assert.match(text(calls), /You can use the same percentage for both tiers, or a different one for each\./);
    assert.match(text(calls), /Press a percentage to use it for \*\*both tiers\*\*, or \*\*Different for each tier\*\*/);
    assert.match(text(calls), /`\/setup safety-pay mode:on tier2-loss:10 tier3-loss:40`/);
    assert.ok(text(calls).length < 1900, `${text(calls).length}`);
    assert.deepEqual(buttons(calls).map((b) => b.custom_id), [`safety:0:${pid()}`, `safety:25:${pid()}`, `safety:50:${pid()}`, `safety:100:${pid()}`, `safety:split:${pid()}`, `safety:cancel:${pid()}`]);
    assert.deepEqual(buttons(calls).map((b) => b.label), ['Lose nothing (0%)', 'Lose 25%', 'Lose 50%', 'Lose all (100%)', 'Different for each tier', 'Cancel']);
    assert.equal(panel().safetyPaySince, null, 'nothing is on until they answer');
  });

  it('turns on from now with the percentage given in the command, and says exactly what it does', async () => {
    const t = text(await run({ mode: 'on', 'minimum-loss': 25 }));
    assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 25, 25]);
    assert.match(t, /Landing safety pay is \*\*on\*\* for \*\*Test Air\*\*, for flights that landed after <t:\d+:f>/);
    assert.match(t, /Tier 1\*\*, landing at -375 to -399 fpm: the pilot is sent a warning, and there is no fine/);
    assert.match(t, /Tier 2\*\*, -400 to -599 fpm: the pilot is paid \*\*8%\*\*/);
    assert.match(t, /Tier 3\*\*, -600 fpm and harder: the pilot is paid \*\*5%\*\*/);
    assert.match(t, /a pilot loses \*\*25%\*\* of the \$2,000 minimum pay, so a hard landing never takes the pay below \$1,500, and a flight that lost money is paid by its distance less 25%/);
  });

  it('says what no loss and a total loss mean', async () => {
    assert.match(text(await run({ mode: 'on', 'minimum-loss': 0 })), /a pilot loses \*\*nothing\*\* of the \$2,000 minimum pay/);
    assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 0, 0]);
    assert.match(text(await run({ 'minimum-loss': 100 })), /a pilot loses \*\*all\*\* of the \$2,000 minimum pay\. There is no minimum: the pay is exactly the tier's share, and a flight that lost money pays nothing/);
    assert.deepEqual([panel().safetyLossTier2, panel().safetyLossTier3], [100, 100]);
  });

  it('says that, if in doubt, it leaves the flight alone and tells the managers, and where the reports go', async () => {
    const t = text(await run({ mode: 'on', 'minimum-loss': 0 }));
    assert.match(t, /If in doubt, I leave it alone\./);
    assert.match(t, /is \*\*not filled in\*\* by `\/setup profit` \(neither its profit nor its pay\), and the server owner \(no manager role is set: `\/setup refresh-roles` sets one\) is told/);
    assert.match(t, /When a pilot lands at Tier 2 or Tier 3, the server owner[^]*is sent a report by DM \(pilot, FsHub ID, flight, route, landing time and rate\), and a row is added to \*\*hard-landings\.csv\*\* in my data folder/);
    assert.match(t, /The light-hearted remark follows it for a landing of -600 fpm or harder, unless the pilot switched the remarks off/);
  });

  it('names the manager roles that get the reports: the refresh roles and the profit write role', async () => {
    h.store.addRefreshRole(panel().guildId, '810000000000000001', NOW);
    h.store.updatePanel(pid(), { profitRoleId: '820000000000000002' });
    const t = text(await run({ mode: 'on', 'minimum-loss': 0 }));
    assert.match(t, /members of <@&810000000000000001>, <@&820000000000000002> is told/);
    assert.doesNotMatch(t, /server owner/);
  });

  it('cannot be turned on without what it needs: a FsHub token, a link to the airline\'s FsHub roster, and its flights being read', async () => {
    d.ctx.fshub = null;
    assert.match(text(await run({ mode: 'on', 'minimum-loss': 0 })), /no FsHub token/);
    d.ctx.fshub = new FakeFsHub();
    h.store.updatePanel(pid(), { fshubAirlineId: null });
    assert.match(text(await run({ mode: 'on', 'minimum-loss': 0 })), /link \*\*Test Air\*\* to its airline's FsHub roster first/);
    h.store.updatePanel(pid(), { fshubAirlineId: 4242, fshubConfirm: false });
    assert.match(text(await run({ mode: 'on' })), /Reading FsHub's flights is switched off/);
    assert.equal(panel().safetyPaySince, null);
  });

  it('refuses a percentage that is not a whole number from 0 to 100', async () => {
    await assert.rejects(run({ mode: 'on', 'minimum-loss': 101 }), /whole numbers of per cent, from 0 to 100/);
    await assert.rejects(run({ mode: 'on', 'minimum-loss': -1 }), /whole numbers of per cent, from 0 to 100/);
    await assert.rejects(run({ mode: 'on', 'minimum-loss': 12.5 }), /whole numbers of per cent, from 0 to 100/);
    assert.equal(panel().safetyPaySince, null);
  });

  it('changes the percentage while it is on, without moving the day it started', async () => {
    await run({ mode: 'on', 'minimum-loss': 0 });
    h.clock.advance(DAY);
    const t = text(await run({ 'minimum-loss': 40 }));
    assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 40, 40]);
    assert.match(t, /^Done\. /);
    assert.match(text(await run({ mode: 'on', 'minimum-loss': 60 })), /^Done\. It was already on; the percentages are changed\. /);
    assert.match(text(await run({ mode: 'on', 'minimum-loss': 60 })), /^It is already on\. /);
    assert.match(text(await run({ 'minimum-loss': 60 })), /^That is how it already is\. /);
  });

  it('saves a percentage given while it is off, and says it is still off', async () => {
    const t = text(await run({ 'minimum-loss': 15 }));
    assert.equal(panel().safetyPaySince, null);
    assert.deepEqual([panel().safetyLossTier2, panel().safetyLossTier3], [15, 15]);
    assert.match(t, /^Saved\. Safety pay is still off, and will use this when you turn it on\./);
    await run({ mode: 'on', 'minimum-loss': 15 });
    assert.deepEqual([panel().safetyLossTier2, panel().safetyLossTier3], [15, 15]);
  });

  it('turns off, and says pay returns to what it was for flights that land from then on', async () => {
    await run({ mode: 'on', 'minimum-loss': 0 });
    const t = text(await run({ mode: 'off' }));
    assert.equal(panel().safetyPaySince, null);
    assert.match(t, /^Done\. Flights that land from now on are paid as they always were, and the light-hearted remarks about hard landings are back/);
    assert.match(text(await run({ mode: 'off' })), /^It was already off\. /);
  });

  it('is a setting of each panel: another airline in the server is not touched', async () => {
    const other = h.store.createPanel({ guildId: panel().guildId, name: 'Other Air', abbr: 'OTH', prefix: 'OTH', channelId: '700000000000000044', now: T0 });
    h.store.updatePanel(other.id, { fshubAirlineId: 4243, fshubConfirm: true });
    await run({ mode: 'on', 'minimum-loss': 30, airline: 'Other Air' });
    assert.deepEqual([h.store.getPanel(other.id)!.safetyPaySince, h.store.getPanel(other.id)!.safetyLossTier2, h.store.getPanel(other.id)!.safetyLossTier3], [NOW, 30, 30]);
    assert.equal(panel().safetyPaySince, null);
  });

  const both = () => [panel().safetyLossTier2, panel().safetyLossTier3];

  it('sets a percentage for each tier with tier2-loss and tier3-loss, and says each one in words', async () => {
    const t = text(await run({ mode: 'on', 'tier2-loss': 10, 'tier3-loss': 40 }));
    assert.deepEqual([panel().safetyPaySince, ...both()], [NOW, 10, 40]);
    assert.match(t, /\*\*The minimum, set for each tier:\*\* a pilot loses \*\*10%\*\* of the \$2,000 minimum pay after a Tier 2 landing, so a hard landing never takes the pay below \$1,800, and a flight that lost money is paid by its distance less 10%; a pilot loses \*\*40%\*\* of the \$2,000 minimum pay after a Tier 3 landing, so a hard landing never takes the pay below \$1,200, and a flight that lost money is paid by its distance less 40%\./);
    assert.match(t, /Change the percentages with `\/setup safety-pay minimum-loss:\.\.\.` \(both tiers\) or `tier2-loss:\.\.\.` and `tier3-loss:\.\.\.`/);
  });

  it('says the minimum is the same for both tiers when the two percentages are equal, however they were given', async () => {
    assert.match(text(await run({ mode: 'on', 'tier2-loss': 25, 'tier3-loss': 25 })), /\*\*The minimum, the same for both tiers:\*\* a pilot loses \*\*25%\*\*/);
    assert.deepEqual(both(), [25, 25]);
  });

  it('says nothing lost for one tier and all of it for the other', async () => {
    const t = text(await run({ mode: 'on', 'tier2-loss': 0, 'tier3-loss': 100 }));
    assert.match(t, /a pilot loses \*\*nothing\*\* of the \$2,000 minimum pay after a Tier 2 landing/);
    assert.match(t, /a pilot loses \*\*all\*\* of the \$2,000 minimum pay after a Tier 3 landing\. There is no minimum/);
  });

  it('refuses one percentage for both tiers given together with one for a tier, or a tier percentage out of range', async () => {
    await assert.rejects(run({ mode: 'on', 'minimum-loss': 10, 'tier2-loss': 20 }), /`minimum-loss` \(one percentage for both tiers\) or `tier2-loss` and `tier3-loss` \(one for each\), not both/);
    await assert.rejects(run({ 'minimum-loss': 10, 'tier3-loss': 20 }), /not both/);
    await assert.rejects(run({ mode: 'on', 'tier2-loss': 101, 'tier3-loss': 5 }), /whole numbers of per cent, from 0 to 100/);
    await assert.rejects(run({ mode: 'on', 'tier2-loss': 5, 'tier3-loss': -1 }), /whole numbers of per cent, from 0 to 100/);
    assert.equal(panel().safetyPaySince, null);
  });

  it('needs both tiers to turn it on with a percentage for each, and changes nothing until it has them', async () => {
    const t = text(await run({ mode: 'on', 'tier2-loss': 10 }));
    assert.match(t, /I need both: give `tier2-loss` and `tier3-loss`, or `minimum-loss` for both tiers at once/);
    assert.equal(panel().safetyPaySince, null);
    assert.match(text(await run({ mode: 'on', 'tier3-loss': 10 })), /I need both/);
    assert.equal(panel().safetyPaySince, null);
  });

  it('changes one tier on its own while it is on, leaving the other and the day it started', async () => {
    await run({ mode: 'on', 'tier2-loss': 10, 'tier3-loss': 40 });
    h.clock.advance(DAY);
    assert.match(text(await run({ 'tier3-loss': 60 })), /^Done\. /);
    assert.deepEqual([panel().safetyPaySince, ...both()], [NOW, 10, 60]);
    assert.match(text(await run({ 'tier2-loss': 5 })), /^Done\. /);
    assert.deepEqual(both(), [5, 60]);
    assert.match(text(await run({ 'tier2-loss': 5 })), /^That is how it already is\. /);
    assert.match(text(await run({ mode: 'on', 'tier3-loss': 20 })), /^Done\. It was already on; the percentages are changed\. /);
    assert.deepEqual(both(), [5, 20]);
    assert.match(text(await run({ mode: 'on', 'tier3-loss': 20 })), /^It is already on\. /);
  });

  it('puts both tiers back to one percentage with minimum-loss, whatever they were', async () => {
    await run({ mode: 'on', 'tier2-loss': 10, 'tier3-loss': 40 });
    assert.match(text(await run({ 'minimum-loss': 30 })), /\*\*The minimum, the same for both tiers:\*\*/);
    assert.deepEqual(both(), [30, 30]);
  });

  it('saves a percentage for each tier given while it is off, and a tier on its own, and uses them when it is turned on', async () => {
    assert.match(text(await run({ 'tier3-loss': 40 })), /^Saved\. Safety pay is still off, and will use this when you turn it on\./);
    assert.deepEqual([panel().safetyPaySince, ...both()], [null, 0, 40]);
    await run({ 'tier2-loss': 10 });
    assert.deepEqual(both(), [10, 40]);
    await run({ mode: 'on', 'tier2-loss': 10, 'tier3-loss': 40 });
    assert.deepEqual([panel().safetyPaySince, ...both()], [NOW, 10, 40]);
  });

  describe('writing the deductions in the sheet', () => {
    const on = () => run({ mode: 'on', 'minimum-loss': 0 });

    it('is off for a new panel, and the status says so and how to switch it on', async () => {
      assert.equal(panel().safetyDeductions, false);
      await on();
      const t = text(await run());
      assert.match(t, /\*\*In the sheet\.\*\* What a hard landing takes off the pay is not written in the sheet\. `\/setup safety-pay deductions:on` writes it in a \*\*Safety Deductions\*\* column beside the Pilot Pay/);
    });

    it('is switched on and off with deductions, and the status says what it does', async () => {
      await on();
      const t = text(await run({ deductions: 'on' }));
      assert.equal(panel().safetyDeductions, true);
      assert.match(t, /^Done: from now on `\/setup profit` also writes what a hard landing takes off a pilot's pay in the sheet's Safety Deductions column\. Landing safety pay is \*\*on\*\*/);
      assert.match(t, /\*\*In the sheet\.\*\* What a hard landing takes off a pilot's pay \(what the flight would have paid, less what it pays\) is written in the sheet's \*\*Safety Deductions\*\* column, beside the Pilot Pay that `\/setup profit` fills in\. The sheet needs that column \(I never add one\)/);
      assert.match(text(await run()), /is written in the sheet's \*\*Safety Deductions\*\* column/, 'and the plain status still says so');
      assert.match(text(await run({ deductions: 'off' })), /^Done: deductions are no longer written in the sheet\. /);
      assert.equal(panel().safetyDeductions, false);
    });

    it('says when it was already so, and changes nothing', async () => {
      await on();
      assert.match(text(await run({ deductions: 'off' })), /^Deductions were already not being written in the sheet\. /);
      await run({ deductions: 'on' });
      assert.match(text(await run({ deductions: 'on' })), /^Deductions were already being written in the sheet\. /);
      assert.equal(panel().safetyDeductions, true);
    });

    it('is saved while safety pay is off too, and says it starts when safety pay is on', async () => {
      assert.equal(panel().safetyPaySince, null);
      const t = text(await run({ deductions: 'on' }));
      assert.equal(panel().safetyDeductions, true);
      assert.match(t, /^Done: from now on `\/setup profit` also writes[^]*Safety Deductions column \(once safety pay is on\)\. Landing safety pay is \*\*off\*\*/);
      assert.equal(panel().safetyPaySince, null, 'and safety pay is not turned on by it');
    });

    it('goes with turning safety pay on: said first, and kept whatever is asked next', async () => {
      const q = await run({ mode: 'on', deductions: 'on' });
      assert.match(text(q), /^Done: from now on `\/setup profit` also writes[^]*\(once safety pay is on\)\.\n/);
      assert.match(text(q), /Turn on landing safety pay/, 'the question about the percentage follows');
      assert.equal(panel().safetyDeductions, true);
      assert.equal(panel().safetyPaySince, null, 'the question has not been answered yet');
      const given = text(await run({ mode: 'on', 'minimum-loss': 25, deductions: 'on' }));
      assert.match(given, /^Deductions were already being written in the sheet\. Done\. Landing safety pay is \*\*on\*\*/);
      assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2], [NOW, 25]);
    });

    it('is asked of admins only, like the rest of /setup', async () => {
      await assert.rejects(run({ deductions: 'on' }, false), /Only server admins/);
      assert.equal(panel().safetyDeductions, false);
    });

    it('is on the message after the buttons too, and is the one thing that does not change when the percentages do', async () => {
      await run({ deductions: 'on' });
      const f = fakeComponent(alice, `safety:25:${pid()}`, { admin: true });
      await handler.handle(d.ctx, f.i);
      assert.match(String(f.calls.updates[0].content), /is written in the sheet's \*\*Safety Deductions\*\* column/);
      await run({ 'minimum-loss': 10 });
      assert.equal(panel().safetyDeductions, true);
    });
  });

  describe('who the status says the reports reach', () => {
    const ROLE = '810000000000000001';
    const withCheck = (check: { ids: string[]; found: number; readable: boolean }) => {
      d.ctx.managerCheck = async () => check;
    };
    const reach = (t: string) => t.split('\n').find((l) => /Who is sent them/.test(l)) ?? '';

    it('names the people holding the /setup refresh-roles role, when it can see them', async () => {
      h.store.addRefreshRole(h.panel.guildId, ROLE, NOW);
      withCheck({ ids: ['1001', '1002'], found: 2, readable: true });
      const line = reach(text(await run({ mode: 'on', 'minimum-loss': 0 })));
      assert.match(line, /the 2 members holding <@&810000000000000001> now: <@1001>, <@1002>\./);
      assert.doesNotMatch(line, /⚠️/);
      assert.match(reach(text(await run())), /<@1001>, <@1002>/, 'and the same in the status afterwards');
    });

    it("warns, and says how to fix it, when the member list can't be read", async () => {
      h.store.addRefreshRole(h.panel.guildId, ROLE, NOW);
      withCheck({ ids: ['555'], found: 0, readable: false });
      const line = reach(text(await run({ mode: 'on', 'minimum-loss': 0 })));
      assert.match(line, /^• ⚠️ \*\*Who is sent them:\*\* I can't read this server's member list/);
      assert.match(line, /server owner \(<@555>\) alone/);
      assert.match(line, /Server Members Intent/);
    });

    it('warns when nobody holds the role, and says so plainly when no role is set', async () => {
      h.store.addRefreshRole(h.panel.guildId, ROLE, NOW);
      withCheck({ ids: ['555'], found: 0, readable: true });
      assert.match(reach(text(await run({ mode: 'on', 'minimum-loss': 0 }))), /⚠️ \*\*Who is sent them:\*\* nobody holds <@&810000000000000001> at the moment, so every report goes to the server owner \(<@555>\)/);
      h.store.removeRefreshRole(h.panel.guildId, ROLE);
      assert.match(reach(text(await run())), /only the server owner \(<@555>\), since no manager role is set\. `\/setup refresh-roles`/);
    });

    it('names at most ten people', async () => {
      h.store.addRefreshRole(h.panel.guildId, ROLE, NOW);
      const ids = Array.from({ length: 14 }, (_, i) => String(2000 + i));
      withCheck({ ids, found: 14, readable: true });
      const line = reach(text(await run({ mode: 'on', 'minimum-loss': 0 })));
      assert.match(line, /the 14 members/);
      assert.match(line, /<@2009> and 4 more\./);
      assert.doesNotMatch(line, /<@2010>/);
    });

    it('says nothing of it where the bot has no way to look, or the look fails, and the status still works', async () => {
      d.ctx.managerCheck = undefined;
      assert.doesNotMatch(text(await run({ mode: 'on', 'minimum-loss': 0 })), /Who is sent them/);
      d.ctx.managerCheck = async () => {
        throw new Error('boom');
      };
      const t = text(await run());
      assert.match(t, /Landing safety pay is \*\*on\*\*/);
      assert.doesNotMatch(t, /Who is sent them/);
    });

    it('is on the message that follows the buttons too', async () => {
      h.store.addRefreshRole(h.panel.guildId, ROLE, NOW);
      withCheck({ ids: ['1001'], found: 1, readable: true });
      const f = fakeComponent(alice, `safety:25:${pid()}`, { admin: true });
      await handler.handle(d.ctx, f.i);
      assert.match(String(f.calls.updates[0].content), /the 1 member holding <@&810000000000000001> now: <@1001>\./);
    });
  });

  describe('the buttons under the question', () => {
    const press = async (way: string, o: { admin?: boolean; guildId?: string | null } = {}, id: number | string = pid()) => {
      const f = fakeComponent(alice, `safety:${way}:${id}`, { admin: o.admin ?? true, ...(o.guildId !== undefined ? { guildId: o.guildId } : {}) });
      await handler.handle(d.ctx, f.i);
      return f.calls;
    };

    it('turn it on with the percentage pressed, and say what it does', async () => {
      const calls = await press('25');
      assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 25, 25]);
      assert.match(String(calls.updates[0].content), /^Done\. Landing safety pay is \*\*on\*\*/);
      assert.match(String(calls.updates[0].content), /loses \*\*25%\*\*/);
      assert.deepEqual(calls.updates[0].components, [], 'the buttons are gone');
    });

    it('turn it on with nothing lost, and with all of it lost', async () => {
      await press('0');
      assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 0, 0]);
      h.store.updatePanel(pid(), { safetyPaySince: null });
      await press('100');
      assert.deepEqual([panel().safetyLossTier2, panel().safetyLossTier3], [100, 100]);
    });

    it('change only the percentage when it is already on', async () => {
      await run({ mode: 'on', 'minimum-loss': 0 });
      h.clock.advance(DAY);
      await press('50');
      assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 50, 50]);
    });

    it('do nothing on Cancel', async () => {
      const calls = await press('cancel');
      assert.equal(calls.updates[0].content, 'Okay, nothing was changed.');
      assert.equal(panel().safetyPaySince, null);
    });

    it('are refused to anyone who is not a server admin, from a DM, for another server\'s panel, for a panel that has gone, or a button of the wrong kind', async () => {
      await assert.rejects(press('25', { admin: false }), /Only server admins/);
      await assert.rejects(press('25', { guildId: null }), /only works inside a server/);
      await assert.rejects(press('25', { guildId: 'another-server' }), /no longer active/);
      await assert.rejects(press('25', {}, 99999), /no longer active/);
      await assert.rejects(press('explode'), /out of date/);
      await assert.rejects(press('101'), /out of date/);
      await assert.rejects(press('-5'), /out of date/);
      await assert.rejects(press('25', {}, 'x'), /out of date/);
      assert.equal(panel().safetyPaySince, null);
    });

    it('say what is missing, instead of turning it on, when the panel lost its FsHub link since the question was asked', async () => {
      h.store.updatePanel(pid(), { fshubAirlineId: null });
      const calls = await press('25');
      assert.match(String(calls.updates[0].content), /link \*\*Test Air\*\* to its airline's FsHub roster first/);
      assert.equal(panel().safetyPaySince, null);
    });
  });

  describe('setting the tiers apart with the buttons', () => {
    const press = async (way: string, o: { admin?: boolean; guildId?: string | null } = {}, id: number | string = pid()) => {
      const f = fakeComponent(alice, `safety:${way}:${id}`, { admin: o.admin ?? true, ...(o.guildId !== undefined ? { guildId: o.guildId } : {}) });
      await handler.handle(d.ctx, f.i);
      return f.calls;
    };
    const idsOf = (calls: { updates: any[] }) => (calls.updates[0].components as any[]).flatMap((r) => r.toJSON().components).map((b: any) => b.custom_id);
    const labelsOf = (calls: { updates: any[] }) => (calls.updates[0].components as any[]).flatMap((r) => r.toJSON().components).map((b: any) => b.label);

    it('ask about Tier 2 first, with nothing changed yet', async () => {
      const calls = await press('split');
      const t = String(calls.updates[0].content);
      assert.match(t, /: Tier 2\*\* \(landing at -400 to -599 fpm\)\./);
      assert.match(t, /What percentage of the \*\*\$2,000 minimum pay\*\* should a pilot lose after a Tier 2 landing\?/);
      assert.match(t, /Next I will ask about Tier 3\./);
      assert.deepEqual(idsOf(calls), [`safety:a0:${pid()}`, `safety:a25:${pid()}`, `safety:a50:${pid()}`, `safety:a100:${pid()}`, `safety:cancel:${pid()}`]);
      assert.deepEqual(labelsOf(calls), ['Lose nothing (0%)', 'Lose 25%', 'Lose 50%', 'Lose all (100%)', 'Cancel']);
      assert.equal(panel().safetyPaySince, null);
    });

    it('then ask about Tier 3, carrying the answer for Tier 2, still with nothing changed', async () => {
      const calls = await press('a10');
      const t = String(calls.updates[0].content);
      assert.match(t, /: Tier 3\*\* \(landing at -600 fpm and harder\)\. Tier 2 will lose \*\*10%\*\*\./);
      assert.deepEqual(idsOf(calls), [`safety:b0-10:${pid()}`, `safety:b25-10:${pid()}`, `safety:b50-10:${pid()}`, `safety:b100-10:${pid()}`, `safety:cancel:${pid()}`]);
      assert.equal(panel().safetyPaySince, null);
    });

    it('turn it on with the percentage for each tier when Tier 3 is answered, and say it is set for each tier', async () => {
      const calls = await press('b50-10');
      assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 10, 50]);
      assert.match(String(calls.updates[0].content), /^Done\. Landing safety pay is \*\*on\*\*/);
      assert.match(String(calls.updates[0].content), /\*\*The minimum, set for each tier:\*\*/);
      assert.deepEqual(calls.updates[0].components, []);
    });

    it('change only the percentages when it is already on', async () => {
      await run({ mode: 'on', 'minimum-loss': 0 });
      h.clock.advance(DAY);
      await press('b100-25');
      assert.deepEqual([panel().safetyPaySince, panel().safetyLossTier2, panel().safetyLossTier3], [NOW, 25, 100]);
    });

    it('can be cancelled at either step', async () => {
      assert.equal((await press('cancel')).updates[0].content, 'Okay, nothing was changed.');
      assert.equal(panel().safetyPaySince, null);
    });

    it('are refused to anyone who is not a server admin, and for a button of the wrong kind', async () => {
      await assert.rejects(press('split', { admin: false }), /Only server admins/);
      await assert.rejects(press('a10', { admin: false }), /Only server admins/);
      await assert.rejects(press('b10-10', { guildId: 'another-server' }), /no longer active/);
      for (const bad of ['a101', 'a', 'b10', 'b10-101', 'b101-10', 'b-1-5', 'x25', 'a10-5', 'split2']) await assert.rejects(press(bad), /out of date/, bad);
      assert.equal(panel().safetyPaySince, null);
    });

    it('say what is missing at every step when the panel lost its FsHub link, and change nothing', async () => {
      h.store.updatePanel(pid(), { fshubAirlineId: null });
      for (const way of ['split', 'a10', 'b10-10']) {
        const calls = await press(way);
        assert.match(String(calls.updates[0].content), /link \*\*Test Air\*\* to its airline's FsHub roster first/, way);
      }
      assert.equal(panel().safetyPaySince, null);
    });
  });

  it('is described by safetyStatus for a panel that is on and one that is off', () => {
    assert.match(safetyStatus({ ...panel(), safetyPaySince: null }), /is \*\*off\*\*/);
    assert.match(safetyStatus({ ...panel(), safetyPaySince: NOW }, 'Done. '), /^Done\. Landing safety pay is \*\*on\*\*/);
  });
});

/* ------------------------------------------------------------------ the pay list */

describe('paying from the sheet when pay is linked to safety', () => {
  const flight = { payRaw: '$1,500', profit: 54489 };

  it('raises a pay below the airline\'s usual rule to it, as always', () => {
    assert.deepEqual(payAmount(flight, null), { cents: 200_000, sheetCents: 150_000, lossNm: null, needsDistance: false });
  });

  it('pays the cell as it stands where the airline links pay to safety: the cut was made when the cell was filled, and must not be undone', () => {
    assert.deepEqual(payAmount(flight, null, true), { cents: 150_000, sheetCents: null, lossNm: null, needsDistance: false });
    assert.deepEqual(payAmount({ payRaw: '$1,334', profit: -8000 }, 1502, true), { cents: 133_400, sheetCents: null, lossNm: null, needsDistance: false }, 'a cut loss pay is not raised to the distance rule');
  });

  it('still has no pay to give for a cell with nothing in it', () => {
    assert.equal(payAmount({ payRaw: '', profit: 54489 }, null, true), null);
    assert.equal(payAmount({ payRaw: '$0', profit: 54489 }, null, true), null);
  });
});

/* ------------------------------------------------------------------ the database */

describe('the safety pay settings in the database', () => {
  it('is off, with nothing lost in either tier, for a new panel, and each percentage is kept between 0 and 100', async () => {
    const h = await makeHarness();
    try {
      assert.deepEqual([h.panel.safetyPaySince, h.panel.safetyLossTier2, h.panel.safetyLossTier3], [null, 0, 0]);
      const get = () => h.store.getPanel(h.panel.id)!;
      h.store.updatePanel(h.panel.id, { safetyPaySince: 12345, safetyLossTier2: 10, safetyLossTier3: 40 });
      assert.deepEqual([get().safetyPaySince, get().safetyLossTier2, get().safetyLossTier3], [12345, 10, 40]);
      h.store.updatePanel(h.panel.id, { safetyLossTier3: 250 });
      assert.deepEqual([get().safetyLossTier2, get().safetyLossTier3], [10, 100], 'one tier can be changed on its own');
      h.store.updatePanel(h.panel.id, { safetyLossTier2: -3 });
      assert.deepEqual([get().safetyLossTier2, get().safetyLossTier3], [0, 100]);
      h.store.updatePanel(h.panel.id, { safetyPaySince: null });
      assert.equal(get().safetyPaySince, null);
    } finally {
      await h.close();
    }
  });

  it('is added to a database that has panels, leaving them as they were: off, with nothing lost, and the two new tables empty', () => {
    const step = MIGRATIONS.findIndex((m) => m.includes('safety_pay_since'));
    assert.ok(step > 0, 'the step exists');
    const old = new DatabaseSync(':memory:');
    for (let v = 0; v < step; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    old.exec(MIGRATIONS[step] as string);
    const row = old.prepare('SELECT safety_pay_since AS s, safety_loss_tier2 AS k, safety_loss_tier3 AS j FROM panels').get() as { s: number | null; k: number; j: number };
    assert.deepEqual([row.s, row.k, row.j], [null, 0, 0]);
    assert.equal((old.prepare('SELECT count(*) AS c FROM safety_landings').get() as { c: number }).c, 0);
    assert.equal((old.prepare('SELECT count(*) AS c FROM safety_doubts').get() as { c: number }).c, 0);
  });

  it('keeps whether deductions are written in the sheet, off for a new panel, and adds that to a database that has panels without turning it on', async () => {
    const h = await makeHarness();
    try {
      assert.equal(h.panel.safetyDeductions, false);
      h.store.updatePanel(h.panel.id, { safetyDeductions: true });
      assert.equal(h.store.getPanel(h.panel.id)!.safetyDeductions, true);
      h.store.updatePanel(h.panel.id, { safetyDeductions: false });
      assert.equal(h.store.getPanel(h.panel.id)!.safetyDeductions, false);
    } finally {
      await h.close();
    }
    const step = MIGRATIONS.findIndex((m) => m.includes('safety_deductions'));
    assert.ok(step > 0, 'the step exists');
    const old = new DatabaseSync(':memory:');
    for (let v = 0; v < step; v++) old.exec(MIGRATIONS[v] as string);
    old.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at) VALUES ('g', 1, 'Old Air', 'OLD', 'c', 1)`).run();
    old.exec(MIGRATIONS[step] as string);
    assert.equal((old.prepare('SELECT safety_deductions AS d FROM panels').get() as { d: number }).d, 0);
  });

  describe('what has been done about a landing', () => {
    let h: Harness;
    beforeEach(async () => {
      h = await makeHarness();
    });
    afterEach(() => h.close());

    it('is nothing until something is saved, and a step once done stays done', () => {
      const id = h.panel.id;
      assert.equal(h.store.getSafetyLanding(id, 77), null);
      h.store.saveSafetyLanding(id, 77, { told: 'closed' }, T0);
      assert.deepEqual(h.store.getSafetyLanding(id, 77), { told: 'closed', logged: false, reported: false });
      h.store.saveSafetyLanding(id, 77, { logged: true }, T0 + 1);
      h.store.saveSafetyLanding(id, 77, { told: 'sent' }, T0 + 2);
      assert.deepEqual(h.store.getSafetyLanding(id, 77), { told: 'closed', logged: true, reported: false }, 'a told state is not changed once set');
      h.store.saveSafetyLanding(id, 77, { reported: true }, T0 + 3);
      h.store.saveSafetyLanding(id, 77, {}, T0 + 4);
      assert.deepEqual(h.store.getSafetyLanding(id, 77), { told: 'closed', logged: true, reported: true });
      assert.equal(h.store.getSafetyLanding(id, 78), null, 'per flight');
    });

    it('is remembered per panel, and forgotten after a time, with the flights that were not filled', () => {
      const other = h.store.createPanel({ guildId: h.panel.guildId, name: 'Other', prefix: 'OTH', channelId: '700000000000000055', now: T0 });
      h.store.saveSafetyLanding(h.panel.id, 5, { told: 'sent' }, T0);
      assert.equal(h.store.getSafetyLanding(other.id, 5), null);
      h.store.noteSafetyDoubt(h.panel.id, 'row-1', T0);
      assert.equal(h.store.hasSafetyDoubt(h.panel.id, 'row-1'), true);
      assert.equal(h.store.hasSafetyDoubt(other.id, 'row-1'), false);
      h.store.pruneSafety(T0 + 1);
      assert.equal(h.store.getSafetyLanding(h.panel.id, 5), null);
      assert.equal(h.store.hasSafetyDoubt(h.panel.id, 'row-1'), false, 'forgotten after the cut-off');
    });
  });
});

void HOUR;
