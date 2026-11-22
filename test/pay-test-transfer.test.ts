import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AeroconomyError } from '../src/aeroconomy/http.js';
import type { BankAccount } from '../src/aeroconomy/banking.js';
import { payrollCommand } from '../src/discord/commands/payroll.js';
import { payTestHandler } from '../src/discord/payTestUi.js';
import { NOT_CONNECTED_TEXT, NotConnectedGateway, type PayRequest, type PayResult, type PaymentGateway } from '../src/services/payGateway.js';
import { Payroll } from '../src/services/payrollService.js';
import { findAccount, planTestTransfer, TEST_DEFAULT_CENTS, TEST_MAX_CENTS, testRequest, TestTransferError } from '../src/services/payTest.js';
import { makeHarness, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeComponent, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

/* Everything below is made up: the accounts, the names and the amounts. The gateway is a fake: no money moves and nothing leaves the test. */

const BUSINESS: BankAccount = { number: '9954-0000658', name: 'Example Business 658', type: 'business' };
const PERSONAL: BankAccount = { number: '2002-0004567', name: 'Example Pilot', type: 'personal' };
const OTHER: BankAccount = { number: '9954-0000999', name: 'Example Business 999', type: 'business' };
const ACCOUNTS = [BUSINESS, PERSONAL, OTHER];

/* ------------------------------------------------------------------ the rules */

describe('planning a test transfer', () => {
  it('is a dollar unless said otherwise, and at most ten', () => {
    assert.equal(TEST_DEFAULT_CENTS, 100);
    assert.equal(TEST_MAX_CENTS, 1000);
    assert.equal(planTestTransfer(ACCOUNTS, BUSINESS.number, PERSONAL.number, null).cents, 100);
    assert.equal(planTestTransfer(ACCOUNTS, BUSINESS.number, PERSONAL.number, 0.01).cents, 1);
    assert.equal(planTestTransfer(ACCOUNTS, BUSINESS.number, PERSONAL.number, 10).cents, 1000);
    assert.equal(planTestTransfer(ACCOUNTS, BUSINESS.number, PERSONAL.number, 2.5).cents, 250);
  });

  it('refuses an amount under a cent or over ten dollars, or one that is not a number', () => {
    for (const dollars of [0, -1, 10.01, 100, 5000, Number.NaN, Infinity]) {
      assert.throws(() => planTestTransfer(ACCOUNTS, BUSINESS.number, PERSONAL.number, dollars), (e: unknown) => e instanceof TestTransferError && /between \$0\.01 and \$10\.00/.test(e.message), String(dollars));
    }
  });

  it('only moves money between two accounts the token can see, and never from an account to itself', () => {
    assert.throws(() => planTestTransfer(ACCOUNTS, BUSINESS.number, '2002-7777777', null), /can't see an account matching "2002-7777777"/);
    assert.throws(() => planTestTransfer(ACCOUNTS, '9954-0009999', PERSONAL.number, null), /can't see an account matching/);
    assert.throws(() => planTestTransfer(ACCOUNTS, BUSINESS.number, BUSINESS.number, null), /same account on both sides/);
    assert.throws(() => planTestTransfer(ACCOUNTS, 'Example Business 658', '9954-0000658', null), /same account on both sides/, 'by name and by number is the same account');
    assert.throws(() => planTestTransfer([], BUSINESS.number, PERSONAL.number, null), /can't see an account/);
  });

  it('finds an account by its number (spaces and odd dashes forgiven), its whole name, or the part of its name only one account has', () => {
    assert.equal(findAccount(ACCOUNTS, '9954-0000658', 'from'), BUSINESS);
    assert.equal(findAccount(ACCOUNTS, ' 9954 – 0000658 ', 'from'), BUSINESS);
    assert.equal(findAccount(ACCOUNTS, 'example pilot', 'to'), PERSONAL);
    assert.equal(findAccount(ACCOUNTS, 'EXAMPLE   BUSINESS 658', 'from'), BUSINESS);
    assert.equal(findAccount(ACCOUNTS, 'pilot', 'to'), PERSONAL);
    assert.equal(findAccount(ACCOUNTS, '658', 'from'), BUSINESS, 'the one name with 658 in it');
  });

  it('says so when a name fits more than one account, or none, or nothing was given', () => {
    assert.throws(() => findAccount(ACCOUNTS, 'business', 'from'), /More than one of the accounts I can see matches "business"/);
    assert.throws(() => findAccount(ACCOUNTS, 'nothing like it', 'to'), /can't see an account matching "nothing like it"/);
    assert.throws(() => findAccount(ACCOUNTS, '  ', 'from'), /Say which account the money goes from/);
    assert.throws(() => findAccount(ACCOUNTS, '', 'to'), /Say which account the money goes to/);
  });

  it('keeps what was typed short in the message, so it cannot flood it', () => {
    try {
      findAccount(ACCOUNTS, 'z'.repeat(500), 'from');
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof TestTransferError && e.message.length < 300);
    }
  });

  it('becomes a payment from the first account to the second, for that amount, under the ID given', () => {
    const plan = planTestTransfer(ACCOUNTS, BUSINESS.number, PERSONAL.number, 1);
    assert.deepEqual(testRequest(plan, 'fpb-test-abc123'), {
      sourceAccount: BUSINESS.number,
      recipientAccount: PERSONAL.number,
      uniqueId: 'fpb-test-abc123',
      cents: 100,
      description: 'Flight Panel Bot test transfer',
    });
  });
});

/* ------------------------------------------------------------------ the command and its buttons */

class FakeGateway implements PaymentGateway {
  connected = true;
  calls: PayRequest[] = [];
  mode: 'ok' | 'refuse' | 'silent' = 'ok';
  async pay(request: PayRequest): Promise<PayResult> {
    this.calls.push(request);
    if (this.mode === 'silent') throw new AeroconomyError('Aeroconomy gave no answer to the payment, so nobody knows whether the money moved.');
    if (this.mode === 'refuse') return { ok: false, reason: 'Aeroconomy refused the payment. It said: Insufficient funds.' };
    return { ok: true, reference: '9134', balanceCents: 4_874_900 };
  }
}

describe('/payroll accounts and /payroll test-transfer', () => {
  let h: Harness;
  let d: DiscordHarness;
  let gw: FakeGateway;
  let accounts: () => Promise<BankAccount[]>;
  let asker: FakeUser;
  let other: FakeUser;

  const runAs = async (userId: string, sub: string, options: Record<string, unknown> = {}, admin = true) => {
    const f = fakeInteraction({ sub, admin, userId, options });
    await payrollCommand.execute(d.ctx, f.i);
    return f.calls;
  };
  const run = (sub: string, options: Record<string, unknown> = {}, admin = true) => runAs(USER_A.discordId, sub, options, admin);
  const text = (calls: { edits: Array<{ content?: string }> }) => String(calls.edits.at(-1)?.content ?? '');
  const buttonIds = (calls: { edits: any[] }): string[] => (calls.edits.at(-1)?.components ?? []).flatMap((r: any) => r.toJSON().components).map((b: any) => b.custom_id);
  const press = async (who: FakeUser, customId: string, o: { admin?: boolean } = {}) => {
    const f = fakeComponent(who, customId, { admin: o.admin ?? true });
    await payTestHandler.handle(d.ctx, f.i);
    return f.calls;
  };
  /** Ask for a test transfer, and give back what the admin would see and the button that confirms it. */
  const ask = async (options: Record<string, unknown> = { from: BUSINESS.number, to: PERSONAL.number }) => {
    const calls = await run('test-transfer', options);
    const [go, no] = buttonIds(calls);
    return { calls, go: go as string, no: no as string };
  };

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    gw = new FakeGateway();
    accounts = async () => ACCOUNTS;
    d.ctx.payroll = new Payroll({ store: h.store, gateway: gw, accounts: () => accounts(), now: () => h.clock.now });
    asker = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    other = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
  });
  afterEach(async () => {
    await settle(10);
    await h.close();
  });

  describe('/payroll accounts', () => {
    it('lists the accounts the token can see, with their numbers', async () => {
      const t = text(await run('accounts'));
      assert.match(t, /The accounts the bot can see/);
      assert.match(t, /• \*\*Example Business 658\*\* · business · `9954-0000658`/);
      assert.match(t, /• \*\*Example Pilot\*\* · personal · `2002-0004567`/);
      assert.match(t, /`source-account`/);
    });

    it('says when there are none, and when it cannot ask', async () => {
      accounts = async () => [];
      assert.match(text(await run('accounts')), /can't see any Aeroconomy bank accounts/);
      accounts = async () => {
        throw new AeroconomyError('Aeroconomy did not accept the FsHub token, so I could not read the airline\'s aircraft.', 401);
      };
      await assert.rejects(run('accounts'), /did not accept the FsHub token/);
      d.ctx.payroll = new Payroll({ store: h.store, gateway: new NotConnectedGateway(), now: () => h.clock.now });
      await assert.rejects(run('accounts'), /no FsHub token/);
    });

    it('is for admins only, and shows at most 25', async () => {
      await assert.rejects(run('accounts', {}, false), /Manage Server/);
      accounts = async () => Array.from({ length: 30 }, (_, i) => ({ number: `9954-00001${String(i).padStart(2, '0')}`, name: `Account ${i}`, type: 'business' }));
      assert.match(text(await run('accounts')), /…and 5 more\./);
    });
  });

  describe('asking for a test transfer', () => {
    it('shows what would be sent, and sends nothing until Send is pressed', async () => {
      const { calls, go, no } = await ask();
      const t = text(calls);
      assert.match(t, /Test transfer\*\* · Test Air/);
      assert.match(t, /Send \*\*\$1\.00\*\* from \*\*Example Business 658\*\* \(`9954-0000658`\) to \*\*Example Pilot\*\* \(`2002-0004567`\)\?/);
      assert.match(t, /Nothing is sent until you press \*\*Send\*\*, and pressing it twice sends it once/);
      assert.match(go, /^paytest:go:[0-9a-f]{18}$/);
      assert.match(no, /^paytest:no:[0-9a-f]{18}$/);
      assert.equal(go.split(':')[2], no.split(':')[2]);
      assert.deepEqual(gw.calls, [], 'nothing moved');
    });

    it('takes accounts by name, and an amount other than a dollar', async () => {
      const { calls } = await ask({ from: 'business 658', to: 'pilot', amount: 2.5 });
      assert.match(text(calls), /Send \*\*\$2\.50\*\* from \*\*Example Business 658\*\*[^]*to \*\*Example Pilot\*\*/);
    });

    it('is for admins only', async () => {
      await assert.rejects(run('test-transfer', { from: BUSINESS.number, to: PERSONAL.number }, false), /Manage Server/);
    });

    it('is refused, with the reason, for an account the token cannot see, the same account twice, or too much', async () => {
      await assert.rejects(run('test-transfer', { from: BUSINESS.number, to: '2002-0000001' }), /can't see an account matching "2002-0000001"/);
      await assert.rejects(run('test-transfer', { from: BUSINESS.number, to: BUSINESS.number }), /same account on both sides/);
      await assert.rejects(run('test-transfer', { from: BUSINESS.number, to: PERSONAL.number, amount: 50 }), /between \$0\.01 and \$10\.00/);
      assert.deepEqual(gw.calls, []);
    });

    it('says paying is not connected, and asks for nothing, when there is no bank connection', async () => {
      d.ctx.payroll = new Payroll({ store: h.store, gateway: new NotConnectedGateway(), accounts: () => accounts(), now: () => h.clock.now });
      await assert.rejects(run('test-transfer', { from: BUSINESS.number, to: PERSONAL.number }), (e: unknown) => String((e as Error).message) === NOT_CONNECTED_TEXT);
    });

    it('passes on why the accounts could not be read', async () => {
      accounts = async () => {
        throw new AeroconomyError('Aeroconomy could not be reached (TypeError).');
      };
      await assert.rejects(run('test-transfer', { from: BUSINESS.number, to: PERSONAL.number }), /could not be reached/);
    });
  });

  describe('pressing Send', () => {
    it('sends the payment once, with its own ID, and says what happened: the transaction number and the new balance', async () => {
      const { go } = await ask();
      const calls = await press(asker, go);
      assert.equal(gw.calls.length, 1);
      const sent = gw.calls[0]!;
      assert.equal(sent.sourceAccount, BUSINESS.number);
      assert.equal(sent.recipientAccount, PERSONAL.number);
      assert.equal(sent.cents, 100);
      assert.match(sent.uniqueId, /^fpb-test-[0-9a-f]{16}$/);
      assert.equal(sent.description, 'Flight Panel Bot test transfer');
      assert.match(String(calls.updates[0].content), /^Sending \$1\.00 from/);
      assert.deepEqual(calls.updates[0].components, [], 'the buttons are gone while it sends');
      const result = String(calls.edits.at(-1).content);
      assert.match(result, /✅ Sent \*\*\$1\.00\*\* from \*\*Example Business 658\*\* \(`9954-0000658`\) to \*\*Example Pilot\*\*/);
      assert.match(result, /transaction number: `9134`/);
      assert.match(result, /Example Business 658 now holds \*\*\$48,749\.00\*\*/);
      assert.match(result, /The bank connection works/);
    });

    it('sends it once however often the button is pressed: the second press finds it used', async () => {
      const { go } = await ask();
      await press(asker, go);
      const again = await press(asker, go);
      assert.equal(gw.calls.length, 1);
      assert.match(String(again.updates[0].content), /expired, or was already used\. Nothing was sent/);
    });

    it('gives each test its own ID, so a second test is a second payment', async () => {
      const first = await ask();
      const second = await ask();
      await press(asker, first.go);
      await press(asker, second.go);
      assert.equal(gw.calls.length, 2);
      assert.notEqual(gw.calls[0]!.uniqueId, gw.calls[1]!.uniqueId);
    });

    it('sends nothing on Cancel, and the test cannot be used afterwards', async () => {
      const { go, no } = await ask();
      const calls = await press(asker, no);
      assert.equal(calls.updates[0].content, 'Cancelled. Nothing was sent.');
      await press(asker, go);
      assert.deepEqual(gw.calls, []);
    });

    it('can only be pressed by the admin who asked: another admin, or anyone who is not an admin, is told no and the test stays waiting', async () => {
      const { go } = await ask();
      const byOther = await press(other, go, { admin: true });
      assert.match(String(byOther.replies[0].content), /Only the admin who asked for this test can confirm it/);
      const notAdmin = await press(asker, go, { admin: false });
      assert.match(String(notAdmin.replies[0].content), /Only the admin who asked/);
      assert.deepEqual(gw.calls, []);
      await press(asker, go);
      assert.equal(gw.calls.length, 1, 'and the admin who asked still can');
    });

    it('waits ten minutes, then is gone, and sends nothing', async () => {
      const { go } = await ask();
      h.clock.advance(10 * 60_000 + 1);
      const calls = await press(asker, go);
      assert.match(String(calls.updates[0].content), /expired, or was already used/);
      assert.deepEqual(gw.calls, []);
    });

    it('says Aeroconomy refused, and that nothing was sent', async () => {
      gw.mode = 'refuse';
      const { go } = await ask();
      const calls = await press(asker, go);
      const result = String(calls.edits.at(-1).content);
      assert.match(result, /❌ Aeroconomy did not take it, so nothing was sent\./);
      assert.match(result, /Insufficient funds/);
    });

    it('says when there was no answer, tells the admin to look at the accounts first, and never tries again by itself', async () => {
      gw.mode = 'silent';
      const { go } = await ask();
      const calls = await press(asker, go);
      const result = String(calls.edits.at(-1).content);
      assert.match(result, /⛔ [^\n]*nobody knows whether the money moved/);
      assert.match(result, /Check the transactions of both accounts on Aeroconomy before trying again/);
      assert.equal(gw.calls.length, 1);
    });

    it('stops if the bank connection has gone since it was asked', async () => {
      const { go } = await ask();
      d.ctx.payroll = new Payroll({ store: h.store, gateway: new NotConnectedGateway(), now: () => h.clock.now });
      const calls = await press(asker, go);
      assert.equal(calls.updates[0].content, NOT_CONNECTED_TEXT);
      assert.deepEqual(gw.calls, []);
    });

    it('ignores a button of the wrong kind', async () => {
      await assert.rejects(press(asker, 'paytest:explode:abc'), /out of date/);
      await assert.rejects(press(asker, 'paytest:go'), /out of date/);
    });
  });
});
