import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { BankAccount, BankTransaction } from '../src/aeroconomy/banking.js';
import { AeroconomyError } from '../src/aeroconomy/http.js';
import { BANKING_INTRO, bankingHandler } from '../src/discord/banking.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { BANKING_POLL_MS, BANKING_RETRY_MS, MAX_PAYMENT_MESSAGES, MAX_TOKEN_TRIES, TOKEN_WAIT_MS } from '../src/services/banking.js';
import { paymentMessage } from '../src/services/bankingText.js';
import { Scheduler } from '../src/services/scheduler.js';
import { SecretBox } from '../src/services/secretBox.js';
import { HOUR, makeHarness, T0, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

/* Everything here is made up: the pilots, the accounts, the payments and the tokens. */

const TOKEN_A = 'fsh-alice-token-0123456789abcdef';
const TOKEN_B = 'fsh-bob-token-fedcba9876543210';
const PERSONAL: BankAccount = { number: '2002-0000111', name: 'Alex Personal', type: 'personal' };
const BUSINESS: BankAccount = { number: '9954-0000123', name: 'Alex Air Logistics', type: 'business' };
const OTHER = { number: '7731-0000184', name: 'Example Pilot' };

const tx = (id: number, over: Partial<BankTransaction> = {}): BankTransaction => ({
  id,
  at: T0 - HOUR,
  direction: 'credit',
  description: 'Fuel reimbursement',
  amount: 1250,
  sender: OTHER,
  recipient: { number: PERSONAL.number, name: PERSONAL.name },
  lines: [],
  ...over,
});

let people = 0;

describe('payment messages (/banking)', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    // Fresh people for every test: the short pointer people get has a pause per person that outlives a test.
    alice = d.client.user(new FakeUser(`1${String(++people).padStart(17, '0')}`, 'alice'));
    bob = d.client.user(new FakeUser(`2${String(people).padStart(17, '0')}`, 'bob'));
    d.bank.accountsByToken.set(TOKEN_A, [PERSONAL, BUSINESS]);
    d.bank.accountsByToken.set(TOKEN_B, [{ number: '2002-0000222', name: 'Bob Personal', type: 'personal' }]);
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });

  const say = (u: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(u, text));
  const texts = (u: FakeUser, from = 0) => u.dms.slice(from).map((m) => String(m.content));
  const rows = (m: { components?: Array<{ toJSON(): any }> }) => (m.components ?? []).map((r) => r.toJSON());
  const link = (u: FakeUser = alice) => h.store.getBankingLink(u.id);

  /** Through the whole conversation: ask, send the token, choose accounts. Returns what the pick showed. */
  const setUp = async (u: FakeUser = alice, token = TOKEN_A, pick = [PERSONAL.number, BUSINESS.number]) => {
    await say(u, '/banking');
    await say(u, token);
    const f = fakeComponent(u, 'banking:pick', { values: pick });
    await bankingHandler.handle(d.ctx, f.i);
    return f;
  };
  /** Time passes and the pilots' accounts are looked at. */
  const later = async (ms = BANKING_POLL_MS) => {
    h.clock.advance(ms);
    await d.banking.run();
  };

  describe('asking for it', () => {
    it('explains what it does and where the token comes from, and what handing it over means', async () => {
      await say(alice, '/banking');
      assert.equal(alice.dms.length, 1);
      const text = texts(alice)[0]!;
      assert.equal(text, BANKING_INTRO);
      assert.ok(text.length < 2000, `${text.length} characters`);
      assert.match(text, /into or out of\*\* the Aeroconomy bank accounts you choose/);
      assert.match(text, /only ever \*\*read\*\*/);
      assert.match(text, /FsHub personal access token/);
      assert.match(text, /fshub\.io\/settings\/integrations/);
      assert.match(text, /encrypted\*\* on the computer of whoever runs this bot/);
      assert.match(text, /delete it\*\* as soon as you turn this off/);
      assert.match(text, /delete your message with the token/);
      assert.match(text, /no limits on what a token can do/);
      assert.deepEqual(rows(alice.dms[0]).map((r) => r.components.map((c: any) => c.custom_id)), [['banking:cancel']]);
      assert.deepEqual([link()!.step, link()!.tokenSealed], ['await_token', null]);
    });

    it('answers to the slash being left off, and to capitals', async () => {
      await say(alice, 'banking');
      await say(bob, '  /BANKING ');
      assert.equal(texts(alice)[0], BANKING_INTRO);
      assert.equal(texts(bob)[0], BANKING_INTRO);
    });

    it('reminds someone it is waiting for their token when they say something else, without losing the place', async () => {
      await say(alice, '/banking');
      await say(alice, 'hello there');
      assert.match(texts(alice)[1]!, /waiting for your token/);
      assert.equal(link()!.step, 'await_token');
    });

    it('lets them stop before sending anything, with a word or the button', async () => {
      await say(alice, '/banking');
      await say(alice, 'cancel');
      assert.match(texts(alice)[1]!, /cancelled\. I saved nothing/);
      assert.equal(link(), null);
      await say(bob, '/banking');
      const f = fakeComponent(bob, 'banking:cancel');
      await bankingHandler.handle(d.ctx, f.i);
      assert.match(String(f.calls.updates[0].content), /cancelled\. I saved nothing/);
      assert.equal(link(bob), null);
    });

    it('forgets a conversation that waited too long for the token, and treats a token sent after that as any other message', async () => {
      await say(alice, '/banking');
      h.clock.advance(TOKEN_WAIT_MS + 1);
      await say(alice, TOKEN_A);
      assert.match(texts(alice)[1]!, /To reserve a flight, press \*\*Reserve\*\*/);
      assert.equal(link(), null);
      assert.deepEqual(d.bank.accountCalls, [], 'Aeroconomy was not asked, and the token was not kept');
    });

    it('does not take a long word for a token when nobody asked for one', async () => {
      await say(alice, TOKEN_A);
      assert.deepEqual(d.bank.accountCalls, []);
      assert.equal(link(), null);
      assert.match(texts(alice)[0]!, /To reserve a flight/);
    });

    it('mentions /banking and /monitor in the short pointer people get', async () => {
      await say(alice, 'hello');
      assert.match(texts(alice)[0]!, /`\/banking` sets up a message whenever money goes into or out of your Aeroconomy bank accounts, and `\/monitor SKY330` tells you when a flight is about to land\./);
    });
  });

  describe('the token', () => {
    it('is tried against Aeroconomy; one it does not accept is said so, three tries and it stops, keeping nothing', async () => {
      await say(alice, '/banking');
      for (let i = 1; i < MAX_TOKEN_TRIES; i++) {
        await say(alice, `wrong-token-number-${i}-abcdefgh`);
        assert.match(texts(alice).at(-1)!, /Aeroconomy didn't accept that token\. Check that you copied all of it/);
        assert.equal(link()!.attempts, i);
        assert.equal(link()!.tokenSealed, null);
      }
      await say(alice, 'wrong-token-number-last-abcdefgh');
      assert.match(texts(alice).at(-1)!, /That's 3 tries, so I've stopped and saved nothing/);
      assert.equal(link(), null);
    });

    it('is saved sealed once it works, shown the accounts to choose from, and never repeated back', async () => {
      await say(alice, '/banking');
      await say(alice, TOKEN_A);
      const last = alice.dms.at(-1)!;
      assert.match(String(last.content), /Aeroconomy accepted the token, and I have saved it \(encrypted\)\. \*\*Delete your message with it from this chat now\.\*\*/);
      const menu = rows(last)[0].components[0];
      assert.equal(menu.custom_id, 'banking:pick');
      assert.deepEqual(menu.options.map((o: any) => [o.label, o.value, o.default]), [
        ['Alex Personal · personal', PERSONAL.number, false],
        ['Alex Air Logistics · business', BUSINESS.number, false],
      ]);
      assert.deepEqual([menu.min_values, menu.max_values], [1, 2]);
      const l = link()!;
      assert.equal(l.step, 'choose');
      assert.ok(l.tokenSealed!.startsWith('v1:') && !l.tokenSealed!.includes(TOKEN_A), 'sealed, not the token');
      assert.deepEqual(d.bank.accountCalls, [TOKEN_A]);
      assert.ok(!JSON.stringify(alice.dms).includes(TOKEN_A), 'the token is in no message of the bot\'s');
    });

    it('says plainly when Aeroconomy accepts it but will show no account, or none at all, or cannot be reached, and keeps nothing', async () => {
      d.bank.accountsByToken.set('fsh-empty-token-0123456789abcdef', []);
      await say(alice, '/banking');
      await say(alice, 'fsh-empty-token-0123456789abcdef');
      assert.match(texts(alice).at(-1)!, /shows no bank accounts for it, so there is nothing for me to watch\. I kept nothing/);
      assert.equal(link(), null);

      await say(alice, '/banking');
      d.bank.error = new AeroconomyError("Aeroconomy won't show that to the account the FsHub token belongs to.", 403);
      await say(alice, TOKEN_A);
      assert.match(texts(alice).at(-1)!, /accepted that token but won't show it any bank accounts/);
      assert.equal(link()!.step, 'await_token', 'still waiting for a token that can be used');
      assert.equal(link()!.tokenSealed, null);

      d.bank.error = new AeroconomyError('Aeroconomy answered 500.', 500);
      await say(alice, TOKEN_A);
      assert.match(texts(alice).at(-1)!, /couldn't reach Aeroconomy just now \(Aeroconomy answered 500\)\. I kept nothing/);
      assert.equal(link()!.tokenSealed, null);
      assert.equal(link()!.attempts, 0, 'an outage is not a wrong token');
    });

    it('is deleted again when it was sent but no accounts are chosen in time, and the pilot was told it would be', async () => {
      await say(alice, '/banking');
      await say(alice, TOKEN_A);
      assert.match(texts(alice).at(-1)!, /If you don't choose within 30 minutes, I delete the token again\./);
      assert.ok(link()!.tokenSealed);
      h.clock.advance(TOKEN_WAIT_MS + 1);
      const f = fakeComponent(alice, 'banking:pick', { values: [PERSONAL.number] });
      await bankingHandler.handle(d.ctx, f.i);
      assert.match(String(f.calls.edits.at(-1).content), /out of date/);
      assert.equal(link(), null, 'the token is gone, not kept for a conversation that never finished');
      assert.deepEqual(h.store.listBankingAccounts(alice.id), []);
    });

    it('is also deleted by the sweep that runs with the other checks, and a choice made in time keeps it', async () => {
      await say(alice, '/banking');
      await say(alice, TOKEN_A);
      await say(bob, '/banking');
      await say(bob, TOKEN_B);
      h.clock.advance(TOKEN_WAIT_MS - 1000);
      const f = fakeComponent(bob, 'banking:pick', { values: ['2002-0000222'] });
      await bankingHandler.handle(d.ctx, f.i);
      h.clock.advance(2000);
      await d.banking.run();
      assert.equal(h.store.getBankingLink(alice.id), null, 'Alice never chose');
      assert.equal(link(bob)!.step, 'active', 'Bob did, and is no longer on a clock');
      assert.equal(link(bob)!.expiresAt, null);
      h.clock.advance(TOKEN_WAIT_MS * 10);
      assert.equal(link(bob)!.step, 'active');
    });

    it('is taken in the middle of a Reserve conversation only if it looks like one, and the word cancel is left to that conversation', async () => {
      await say(alice, '/banking');
      h.store.upsertSession({ discordId: alice.id, panelId: h.panel.id, purpose: 'reserve', step: 'await_code', jobId: null, attempts: 0, expiresAt: T0 + HOUR });
      await say(alice, 'cancel');
      assert.match(texts(alice).at(-1)!, /Okay, cancelled\. Press .* on the panel/, 'the Reserve conversation was cancelled');
      assert.equal(link()!.step, 'await_token', 'and the wait for the token is still on');
      await say(alice, TOKEN_A);
      assert.equal(link()!.step, 'choose');
    });
  });

  describe('choosing the accounts', () => {
    beforeEach(() => {
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101)]);
    });

    it('starts them from the newest payment of each, so no history is sent, and says what is watched', async () => {
      const before = d.bank.txCalls.length;
      const f = await setUp();
      const edit = f.calls.edits.at(-1);
      assert.match(String(edit.content), /Payment messages are on/);
      assert.match(String(edit.content), /\*\*Alex Personal\*\* \(personal, …0111\)/);
      assert.match(String(edit.content), /\*\*Alex Air Logistics\*\* \(business, …0123\)/);
      assert.match(String(edit.content), /I look about every 5 minutes/);
      assert.deepEqual(h.store.listBankingAccounts(alice.id).map((a) => [a.number, a.lastTxId]), [[PERSONAL.number, 101], [BUSINESS.number, 0]]);
      assert.equal(link()!.step, 'active');
      assert.equal(texts(alice).length, 2, 'no payment of the past was sent');
      assert.deepEqual(d.bank.txCalls.slice(before).map((c) => [c.account, c.limit]), [[PERSONAL.number, 1], [BUSINESS.number, 1]]);
    });

    it('keeps only what was chosen, and one they own account of is the only kind it offers to watch', async () => {
      await setUp(alice, TOKEN_A, [BUSINESS.number]);
      assert.deepEqual(h.store.listBankingAccounts(alice.id).map((a) => a.number), [BUSINESS.number]);
    });

    it('takes nothing that was not offered, or nothing at all, and says the choice is out of date', async () => {
      await say(alice, '/banking');
      await say(alice, TOKEN_A);
      for (const values of [['9999-0000000'], ['../x', '9999-0000000']]) {
        const f = fakeComponent(alice, 'banking:pick', { values });
        await bankingHandler.handle(d.ctx, f.i);
        assert.match(String(f.calls.edits.at(-1).content), /out of date/);
      }
      assert.deepEqual(h.store.listBankingAccounts(alice.id), []);
      assert.equal(link()!.step, 'choose');
      const stranger = fakeComponent(bob, 'banking:pick', { values: [PERSONAL.number] });
      await bankingHandler.handle(d.ctx, stranger.i);
      assert.match(String(stranger.calls.edits.at(-1).content), /out of date/);
      assert.equal(link(bob), null);
    });

    it('leaves out an account Aeroconomy will not show and says so; if that is all, nothing is changed', async () => {
      d.bank.accountErrors.set(BUSINESS.number, new AeroconomyError('no', 403));
      const f = await setUp();
      assert.match(String(f.calls.edits.at(-1).content), /won't show me \*\*Alex Air Logistics\*\*, so I left it out/);
      assert.deepEqual(h.store.listBankingAccounts(alice.id).map((a) => a.number), [PERSONAL.number]);

      await say(bob, '/banking');
      d.bank.accountsByToken.set(TOKEN_B, [BUSINESS]);
      await say(bob, TOKEN_B);
      const g = fakeComponent(bob, 'banking:pick', { values: [BUSINESS.number] });
      await bankingHandler.handle(d.ctx, g.i);
      assert.match(String(g.calls.edits.at(-1).content), /won't show me \*\*Alex Air Logistics\*\* with your token, so nothing is changed/);
      assert.deepEqual(h.store.listBankingAccounts(bob.id), []);
    });

    it('still watches an account whose first payment could not be read just now, and notes where it stands at the first look', async () => {
      d.bank.accountErrors.set(PERSONAL.number, new AeroconomyError('Aeroconomy answered 500.', 500));
      await setUp(alice, TOKEN_A, [PERSONAL.number]);
      assert.equal(h.store.listBankingAccounts(alice.id)[0]!.lastTxId, null);
      d.bank.accountErrors.clear();
      const before = texts(alice).length;
      await later();
      assert.equal(texts(alice).length, before, 'the history is not sent');
      assert.equal(h.store.listBankingAccounts(alice.id)[0]!.lastTxId, 101);
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102)]);
      await later();
      assert.equal(texts(alice).length, before + 1);
    });
  });

  describe('changing it, and turning it off', () => {
    beforeEach(async () => {
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101)]);
      await setUp();
    });

    it('shows what is watched when sent again, with the list (those watched already picked) and a button to turn it off', async () => {
      await say(alice, '/banking');
      const last = alice.dms.at(-1)!;
      assert.match(String(last.content), /Payment messages are on/);
      const r = rows(last);
      assert.deepEqual(r[0].components[0].options.map((o: any) => [o.value, o.default]), [[PERSONAL.number, true], [BUSINESS.number, true]]);
      assert.deepEqual(r[1].components.map((c: any) => c.custom_id), ['banking:off']);
    });

    it('lets them change the accounts: one left out is dropped, one kept keeps its place, one new starts from now', async () => {
      d.bank.payments.set(BUSINESS.number, [tx(500, { recipient: { number: BUSINESS.number, name: BUSINESS.name } })]);
      const f = fakeComponent(alice, 'banking:pick', { values: [BUSINESS.number] });
      await bankingHandler.handle(d.ctx, f.i);
      assert.deepEqual(h.store.listBankingAccounts(alice.id).map((a) => [a.number, a.lastTxId]), [[BUSINESS.number, 0]], 'the one kept keeps its cursor');
      const g = fakeComponent(alice, 'banking:pick', { values: [PERSONAL.number, BUSINESS.number] });
      await bankingHandler.handle(d.ctx, g.i);
      assert.deepEqual(h.store.listBankingAccounts(alice.id).map((a) => [a.number, a.lastTxId]), [[PERSONAL.number, 101], [BUSINESS.number, 0]], 'the one added starts from its newest payment');
    });

    it('turns off with the button: the token and the accounts are deleted, and it says so', async () => {
      const f = fakeComponent(alice, 'banking:off');
      await bankingHandler.handle(d.ctx, f.i);
      assert.match(String(f.calls.updates[0].content), /Payment messages are \*\*off\*\*\. I have \*\*deleted your token\*\*/);
      assert.deepEqual(f.calls.updates[0].components, []);
      assert.equal(link(), null);
      assert.deepEqual(h.store.listBankingAccounts(alice.id), []);
      const calls = d.bank.txCalls.length;
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102)]);
      await later(BANKING_POLL_MS * 3);
      assert.equal(d.bank.txCalls.length, calls, 'Aeroconomy is not asked about them any more');
      assert.equal(texts(alice).filter((t) => t.includes('+$1,250')).length, 0);
    });

    it('turns off with /banking off (or stop), and says so; when it was not on it says that', async () => {
      await say(alice, '/banking off');
      assert.match(texts(alice).at(-1)!, /Payment messages are \*\*off\*\*\. I have \*\*deleted your token\*\* and the list of accounts from my memory/);
      assert.match(texts(alice).at(-1)!, /fshub\.io\/settings\/integrations/);
      assert.equal(link(), null);
      await say(alice, '/banking stop');
      assert.match(texts(alice).at(-1)!, /Payment messages were not on, and I have no token of yours\./);
    });

    it('can be turned off while still waiting for the token or choosing accounts, which deletes the token it had', async () => {
      await say(bob, '/banking');
      await say(bob, TOKEN_B);
      assert.equal(link(bob)!.step, 'choose');
      assert.ok(link(bob)!.tokenSealed);
      await say(bob, '/banking off');
      assert.equal(link(bob), null);
    });

    it('does not let one pilot touch another\'s: their button turns off only their own', async () => {
      const f = fakeComponent(bob, 'banking:off');
      await bankingHandler.handle(d.ctx, f.i);
      assert.match(String(f.calls.updates[0].content), /were not on/);
      assert.equal(link()!.step, 'active', 'Alice is still watched');
    });

    it('says when Aeroconomy no longer accepts the token, deletes it, and starts again from /banking', async () => {
      d.bank.accountsByToken.delete(TOKEN_A);
      await say(alice, '/banking');
      assert.match(texts(alice).at(-1)!, /no longer accepts the token I had for you, so I've stopped watching your accounts and \*\*deleted the token\*\*/);
      assert.equal(link(), null);
      await say(alice, '/banking');
      assert.equal(texts(alice).at(-1), BANKING_INTRO);
    });

    it('still shows what is watched, and the off button, when Aeroconomy cannot be reached to list the accounts', async () => {
      d.bank.error = new AeroconomyError('Aeroconomy answered 503.', 503);
      await say(alice, '/banking');
      const last = alice.dms.at(-1)!;
      assert.match(String(last.content), /Payment messages are on/);
      assert.match(String(last.content), /couldn't reach Aeroconomy just now to list your accounts \(Aeroconomy answered 503\)/);
      assert.deepEqual(rows(last)[0].components.map((c: any) => c.custom_id), ['banking:off']);
      assert.equal(link()!.step, 'active');
    });

    it('treats a token it can no longer open (the key was lost) as ended, rather than failing', async () => {
      h.store.saveBankingLink({ ...link()!, tokenSealed: SecretBox.inMemory().seal(TOKEN_A) });
      await say(alice, '/banking');
      assert.match(texts(alice).at(-1)!, /can no longer read the token I had saved for you/);
      assert.equal(link(), null);
    });
  });

  describe('telling them about payments', () => {
    beforeEach(async () => {
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101)]);
      await setUp();
    });
    const newDms = (from: number) => texts(alice, from);

    it('says nothing when nothing is new, and does not look before it is due', async () => {
      const calls = d.bank.txCalls.length;
      await d.banking.run();
      assert.equal(d.bank.txCalls.length, calls, 'not due yet');
      const dms = alice.dms.length;
      await later();
      assert.ok(d.bank.txCalls.length > calls, 'looked');
      assert.equal(alice.dms.length, dms);
    });

    it('tells them about money coming in, once, with who it is from and what for', async () => {
      const dms = alice.dms.length;
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102)]);
      await later();
      const sent = newDms(dms);
      assert.equal(sent.length, 1);
      assert.match(sent[0]!, /^💰 \*\*\+\$1,250\*\* into \*\*Alex Personal\*\* \(…0111\)\nFrom \*\*Example Pilot\*\* \(…0184\)\nFor: Fuel reimbursement\n<t:\d+:f>$/);
      assert.equal(h.store.listBankingAccounts(alice.id).find((a) => a.number === PERSONAL.number)!.lastTxId, 102);
      await later();
      assert.equal(newDms(dms).length, 1, 'told once');
    });

    it('tells them about money going out, and the lines of a payment of several', async () => {
      const dms = alice.dms.length;
      d.bank.payments.set(PERSONAL.number, [
        tx(100),
        tx(101),
        tx(102, { direction: 'debit', amount: 80.5, sender: { number: PERSONAL.number, name: PERSONAL.name }, recipient: OTHER, description: 'Fuel', lines: [{ description: 'Jet A-1', amount: 60 }, { description: 'Handling', amount: 20.5 }] }),
      ]);
      await later();
      const sent = newDms(dms)[0]!;
      assert.match(sent, /^💸 \*\*-\$80\.50\*\* out of \*\*Alex Personal\*\* \(…0111\)\nTo \*\*Example Pilot\*\* \(…0184\)\nFor: Fuel\n• Jet A-1: \$60\n• Handling: \$20\.50\n<t:\d+:f>$/);
    });

    it('tells them once about a payment between two of their own accounts, not twice', async () => {
      const dms = alice.dms.length;
      const move = (id: number) => tx(id, { direction: 'debit', amount: 300, description: null, sender: { number: PERSONAL.number, name: PERSONAL.name }, recipient: { number: BUSINESS.number, name: BUSINESS.name } });
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), move(102)]);
      d.bank.payments.set(BUSINESS.number, [{ ...move(102), direction: 'credit' }]);
      await later();
      const sent = newDms(dms);
      assert.equal(sent.length, 1);
      assert.match(sent[0]!, /^↔️ \*\*\$300\*\* moved between your accounts: \*\*Alex Personal\*\* \(…0111\) → \*\*Alex Air Logistics\*\* \(…0123\)/);
      assert.deepEqual(h.store.listBankingAccounts(alice.id).map((a) => a.lastTxId), [102, 102]);
    });

    it('sends them oldest first, across both accounts', async () => {
      const dms = alice.dms.length;
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(105, { amount: 5 }), tx(103, { amount: 3 })]);
      d.bank.payments.set(BUSINESS.number, [tx(104, { amount: 4, recipient: { number: BUSINESS.number, name: BUSINESS.name } })]);
      await later();
      assert.deepEqual(newDms(dms).map((t) => /\+\$(\d+)/.exec(t)![1]), ['3', '4', '5']);
    });

    it('sends the newest ten and a line about the rest when there are many, and reads past the first page for them', async () => {
      const dms = alice.dms.length;
      const many = Array.from({ length: 60 }, (_, i) => tx(200 + i, { amount: i + 1 }));
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), ...many]);
      const calls = d.bank.txCalls.length;
      await later();
      const sent = newDms(dms);
      assert.match(sent[0]!, /^💵 \*\*60\*\* new payments since I last looked\. Here are the newest 10; the rest are in your Aeroconomy bank\.$/);
      assert.equal(sent.length, 1 + MAX_PAYMENT_MESSAGES);
      assert.deepEqual(sent.slice(1).map((t) => /\+\$(\d+)/.exec(t)![1]), ['51', '52', '53', '54', '55', '56', '57', '58', '59', '60']);
      const asked = d.bank.txCalls.slice(calls).filter((c) => c.account === PERSONAL.number);
      assert.equal(asked.length, 2, 'a second page was needed');
      assert.equal(asked[1]!.beforeId, 210, 'from where the first page ended');
      assert.equal(h.store.listBankingAccounts(alice.id).find((a) => a.number === PERSONAL.number)!.lastTxId, 259);
    });

    it('keeps what it could not deliver for later, and tries again after an hour, without telling them twice', async () => {
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102), tx(103)]);
      alice.failDms = true;
      const dms = alice.dms.length;
      await later();
      assert.equal(alice.dms.length, dms);
      assert.equal(h.store.listBankingAccounts(alice.id).find((a) => a.number === PERSONAL.number)!.lastTxId, 101, 'not marked as told');
      assert.equal(link()!.nextPollAt, h.clock.now + BANKING_RETRY_MS);
      alice.failDms = false;
      const calls = d.bank.txCalls.length;
      await later(BANKING_POLL_MS);
      assert.equal(d.bank.txCalls.length, calls, 'it does not keep asking while their DMs are closed');
      await later(BANKING_RETRY_MS);
      assert.equal(newDms(dms).length, 2);
      await later();
      assert.equal(newDms(dms).length, 2);
    });

    it('goes on after a message that failed partway: what reached them is not sent again', async () => {
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102, { amount: 2 }), tx(103, { amount: 3 })]);
      const original = alice.send.bind(alice);
      let sends = 0;
      alice.send = async (p: unknown) => {
        if (++sends === 2) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
        return original(p);
      };
      const dms = alice.dms.length;
      await later();
      assert.equal(newDms(dms).length, 1);
      alice.send = original;
      await later(BANKING_RETRY_MS);
      const all = newDms(dms);
      assert.deepEqual(all.map((t) => /\+\$(\d+)/.exec(t)![1]), ['2', '3']);
    });

    it('stops, deletes the token and says so when Aeroconomy stops accepting it', async () => {
      d.bank.accountsByToken.delete(TOKEN_A);
      const dms = alice.dms.length;
      await later();
      assert.match(newDms(dms)[0]!, /no longer accepts the token I had for you, so I've stopped watching your accounts and \*\*deleted the token\*\*/);
      assert.equal(link(), null);
      assert.deepEqual(h.store.listBankingAccounts(alice.id), []);
    });

    it('stops watching an account Aeroconomy will no longer show, says so, and carries on with the rest', async () => {
      d.bank.accountErrors.set(BUSINESS.number, new AeroconomyError('no', 404));
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102)]);
      const dms = alice.dms.length;
      await later();
      const sent = newDms(dms);
      assert.equal(sent.length, 2);
      assert.match(sent[0]!, /^💰 /);
      assert.match(sent[1]!, /no longer shows me \*\*Alex Air Logistics\*\* \(…0123\), so I've stopped watching it\./);
      assert.deepEqual(h.store.listBankingAccounts(alice.id).map((a) => a.number), [PERSONAL.number]);
      assert.equal(link()!.step, 'active');
    });

    it('turns itself off, and says the token is deleted, when no account is left', async () => {
      d.bank.accountErrors.set(BUSINESS.number, new AeroconomyError('no', 403));
      d.bank.accountErrors.set(PERSONAL.number, new AeroconomyError('no', 403));
      const dms = alice.dms.length;
      await later();
      assert.match(newDms(dms).at(-1)!, /payment messages are \*\*off\*\* and your token is \*\*deleted\*\*/);
      assert.equal(link(), null);
    });

    it('does nothing, and tells nobody, when Aeroconomy is having trouble: it looks again at the next time', async () => {
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102)]);
      d.bank.error = new AeroconomyError('Aeroconomy answered 500.', 500);
      const dms = alice.dms.length;
      await later();
      assert.equal(alice.dms.length, dms);
      assert.equal(link()!.step, 'active');
      assert.equal(link()!.nextPollAt, h.clock.now + BANKING_POLL_MS);
      d.bank.error = null;
      await later();
      assert.equal(newDms(dms).length, 1, 'and the payment is told once it is back');
    });

    it('does not let one account having trouble hold up the other', async () => {
      d.bank.accountErrors.set(BUSINESS.number, new AeroconomyError('Aeroconomy answered 500.', 500));
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102)]);
      const dms = alice.dms.length;
      await later();
      assert.equal(newDms(dms).length, 1);
      assert.equal(h.store.listBankingAccounts(alice.id).length, 2, 'the one with trouble is still watched');
    });

    it('ends, cleanly, a link whose token can no longer be opened', async () => {
      h.store.saveBankingLink({ ...link()!, tokenSealed: SecretBox.inMemory().seal(TOKEN_A), nextPollAt: 0 });
      const dms = alice.dms.length;
      await d.banking.run();
      assert.match(newDms(dms)[0]!, /can no longer read the token I had saved for you/);
      assert.equal(link(), null);
    });

    it('keeps each pilot to their own accounts and token', async () => {
      await setUp(bob, TOKEN_B, ['2002-0000222']);
      const bobCalls = d.bank.txCalls.length;
      d.bank.payments.set('2002-0000222', [tx(900, { amount: 7, recipient: { number: '2002-0000222', name: 'Bob Personal' } })]);
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102)]);
      const [a, b] = [alice.dms.length, bob.dms.length];
      await later();
      assert.equal(newDms(a).length, 1);
      assert.match(newDms(a)[0]!, /Alex Personal/);
      assert.equal(texts(bob, b).length, 1);
      assert.match(texts(bob, b)[0]!, /\*\*\+\$7\*\* into \*\*Bob Personal\*\*/);
      assert.ok(d.bank.txCalls.slice(bobCalls).every((c) => (c.account === '2002-0000222' ? c.token === TOKEN_B : c.token === TOKEN_A)), 'each token only for its own pilot\'s accounts');
    });

    it('makes the words of other players harmless: no mentions, no formatting', async () => {
      const dms = alice.dms.length;
      d.bank.payments.set(PERSONAL.number, [tx(100), tx(101), tx(102, { description: '**bold** @everyone <@123> `code`', sender: { number: OTHER.number, name: '@here _x_' } })]);
      await later();
      const sent = newDms(dms)[0]!;
      assert.ok(!sent.includes('@everyone') && !sent.includes('@here') && !sent.includes('<@123>'));
      assert.match(sent, /\\\*\\\*bold\\\*\\\*/);
      assert.deepEqual(alice.dms.at(-1)!.allowedMentions, { parse: [] });
    });

    it('is run by the scheduler beside its main pass, and a failure there stops nothing else', async () => {
      let runs = 0;
      const ok = new Scheduler(h.jobs, d.refresher, { banking: { run: async () => void runs++ } });
      await ok.tick();
      await ok.idle();
      assert.equal(runs, 1);
      const bad = new Scheduler(h.jobs, d.refresher, { banking: { run: async () => Promise.reject(new Error('boom')) } });
      await assert.doesNotReject(bad.tick());
      await assert.doesNotReject(bad.idle());
    });
  });
});

describe('the words of a payment message', () => {
  const mine = { number: PERSONAL.number, name: PERSONAL.name };
  it('falls back on the direction Aeroconomy gave when neither side is one of theirs, and to a plain line when it gave none', () => {
    const strangers = { sender: { number: '1111-0000001', name: 'A' }, recipient: { number: '2222-0000002', name: 'B' } };
    assert.match(paymentMessage(tx(1, { ...strangers, direction: 'credit' }), [mine]), /^💰 \*\*\+\$1,250\*\* into \*\*Alex Personal\*\*/);
    assert.match(paymentMessage(tx(1, { ...strangers, direction: 'debit' }), [mine]), /^💸 \*\*-\$1,250\*\* out of \*\*Alex Personal\*\*/);
    assert.match(paymentMessage(tx(1, { ...strangers, direction: null }), [mine]), /^💵 \*\*\$1,250\*\* on \*\*Alex Personal\*\* \(…0111\)\n\*\*A\*\* \(…0001\) → \*\*B\*\* \(…0002\)/);
  });
  it('names an account it cannot, and shows only the end of an account number', () => {
    const text = paymentMessage(tx(1, { sender: null }), [mine]);
    assert.match(text, /From an account I cannot name/);
    assert.ok(!text.includes(PERSONAL.number) && text.includes('…0111'));
  });
  it('lists at most four lines of a payment and counts the rest', () => {
    const lines = Array.from({ length: 6 }, (_, i) => ({ description: `item ${i}`, amount: i + 1 }));
    const text = paymentMessage(tx(1, { lines }), [mine]);
    assert.equal(text.split('\n').filter((l) => l.startsWith('• ')).length, 5);
    assert.match(text, /• …and 2 more/);
  });
});
