import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AeroconomyError } from '../src/aeroconomy/http.js';
import { AeroconomyPaymentsClient, amountText, type PaymentRequest } from '../src/aeroconomy/payments.js';
import { AeroconomyGateway, type PayRequest } from '../src/services/payGateway.js';
import { MAX_PAYMENT_CENTS } from '../src/services/payroll.js';
import type { Logger } from '../src/util/log.js';

/* Everything below is made up: the token, the accounts, the amounts. No request leaves the test: `fetch` is a fake. */

const TOKEN = 'TEST-TOKEN-do-not-log-ZZZ';
const SOURCE = '9954-0000123';
const RECIPIENT = '2002-0004567';
const BASE = 'https://aeroconomy.com/api/v1';

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

const payment = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  idempotencyKey: 'fpb-test-0011223344556677',
  sourceAccount: SOURCE,
  recipientAccount: RECIPIENT,
  description: 'Flight Panel Bot test transfer',
  cents: 100,
  ...over,
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** What Aeroconomy answers a good payment with, as its documentation shows it. */
const good = (over: { id?: number; total?: string; recipient?: string; balance?: string } = {}, headers: Record<string, string> = {}): Response =>
  json(
    201,
    {
      message: 'Payment completed.',
      data: {
        id: over.id ?? 9134,
        created_at: '2026-11-22T12:45:30+00:00',
        direction: 'debit',
        description: 'Flight Panel Bot test transfer',
        total_amount: over.total ?? '1.00',
        sender: { account_number: SOURCE, account_name: 'Example Air' },
        recipient: { account_number: over.recipient ?? RECIPIENT, account_name: 'Example Pilot' },
        lines: [{ description: 'Flight Panel Bot test transfer', amount: over.total ?? '1.00' }],
      },
      meta: { source_account_number: SOURCE, balance: over.balance ?? '48749.00' },
    },
    headers,
  );

describe('the Aeroconomy payments client', () => {
  let calls: Call[];
  let answers: Array<Response | Error>;
  let waits: number[];
  let logs: string[];
  const log: Logger = {
    debug: (m, e) => void logs.push(`${m} ${e ?? ''}`),
    info: (m, e) => void logs.push(`${m} ${e ?? ''}`),
    warn: (m, e) => void logs.push(`${m} ${e ?? ''}`),
    error: (m, e) => void logs.push(`${m} ${e ?? ''}`),
  };
  const client = () =>
    new AeroconomyPaymentsClient(TOKEN, {
      logger: log,
      fetchFn: (async (url: string, init: Call['init']) => {
        calls.push({ url: String(url), init });
        const next = answers.shift();
        if (!next) throw new Error('no more answers');
        if (next instanceof Error) throw next;
        return next;
      }) as typeof fetch,
      sleep: async (ms) => void waits.push(ms),
    });
  const bodyOf = (c: Call) => JSON.parse(String(c.init.body));

  beforeEach(() => {
    calls = [];
    answers = [];
    waits = [];
    logs = [];
  });

  describe('sending a payment', () => {
    it('sends exactly what Aeroconomy documents: a POST to /banking/payments with the token, the idempotency key and the itemised body', async () => {
      answers = [good()];
      await client().pay(payment());
      assert.equal(calls.length, 1);
      const c = calls[0]!;
      assert.equal(c.url, `${BASE}/banking/payments`);
      assert.equal(c.init.method, 'POST');
      assert.equal(c.init.redirect, 'manual', 'a redirect is never followed, so the token can never go anywhere else');
      assert.equal(c.init.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(c.init.headers['idempotency-key'], 'fpb-test-0011223344556677');
      assert.equal(c.init.headers['content-type'], 'application/json');
      assert.equal(c.init.headers.accept, 'application/json');
      assert.deepEqual(bodyOf(c), {
        source_account_number: SOURCE,
        recipient_account_number: RECIPIENT,
        description: 'Flight Panel Bot test transfer',
        lines: [{ description: 'Flight Panel Bot test transfer', amount: '1.00' }],
      });
    });

    it('writes the amount as dollars and cents, to the cent', () => {
      assert.equal(amountText(100), '1.00');
      assert.equal(amountText(5), '0.05');
      assert.equal(amountText(1), '0.01');
      assert.equal(amountText(123456), '1234.56');
      assert.equal(amountText(1000), '10.00');
      assert.equal(amountText(50_000_000), '500000.00');
    });

    it('takes a good answer as the payment: its number, whether it was a replay, and what the source account then holds', async () => {
      answers = [good({ id: 9134, balance: '48749.00' })];
      assert.deepEqual(await client().pay(payment()), { ok: true, transactionId: 9134, replayed: false, balanceCents: 4_874_900 });
    });

    it('says when Aeroconomy answered with the original of a payment it had already taken (a replay), and sends nothing more', async () => {
      answers = [good({}, { 'idempotent-replayed': 'true' })];
      const out = await client().pay(payment());
      assert.equal(out.ok && out.replayed, true);
      assert.equal(calls.length, 1);
    });

    it('does not mind a balance it was not told', async () => {
      answers = [json(201, { data: { id: 7, total_amount: '1.00', recipient: { account_number: RECIPIENT } } })];
      assert.deepEqual(await client().pay(payment()), { ok: true, transactionId: 7, replayed: false, balanceCents: null });
    });

    it('cleans and shortens the description, so nothing odd goes into the payment', async () => {
      answers = [good()];
      await client().pay(payment({ description: `Pay\nfor\u0007 ${'x'.repeat(300)}` }));
      const sent = bodyOf(calls[0]!);
      assert.ok(sent.description.length <= 120);
      assert.doesNotMatch(sent.description, /[\u0000-\u001f]/);
      assert.equal(sent.lines[0].description, sent.description);
    });
  });

  describe('checking a payment before it is sent', () => {
    const refused = async (over: Partial<PaymentRequest>) => {
      const out = await client().pay(payment(over));
      assert.equal(out.ok, false);
      assert.equal(calls.length, 0, 'nothing was sent');
      return out as { ok: false; status: number; reason: string };
    };

    it('sends nothing for an ID that is empty, too short, or has anything but letters, digits and . _ : -', async () => {
      for (const key of ['', 'ab', 'has space', 'semi;colon', 'new\nline', 'a'.repeat(121), 'ünï']) assert.match((await refused({ idempotencyKey: key })).reason, /no usable ID/, JSON.stringify(key));
    });

    it('sends nothing when an account is not an account number, or both are the same account', async () => {
      for (const bad of ['', 'x', 'a b', '../../etc', '9954-0000123?x=1', '9954/0000123']) {
        assert.match((await refused({ sourceAccount: bad })).reason, /not an account number/, bad);
        assert.match((await refused({ recipientAccount: bad })).reason, /not an account number/, bad);
      }
      assert.match((await refused({ recipientAccount: SOURCE })).reason, /from an account to itself/);
    });

    it('sends nothing for an amount that is not a whole number of cents above nothing', async () => {
      for (const cents of [0, -1, -100, 1.5, Number.NaN, Infinity, 100_000_000_000]) assert.match((await refused({ cents })).reason, /not an amount that can be paid/, String(cents));
    });

    it('sends nothing for a payment that has no description', async () => {
      assert.match((await refused({ description: ' \n\t ' })).reason, /no description/);
    });
  });

  describe('when Aeroconomy refuses', () => {
    it('says nothing was moved, in words that tell the admin why, for a token it does not accept, an account the token does not control, an ID used for another payment and money that is not there', async () => {
      const cases: Array<[number, RegExp]> = [
        [401, /did not accept the FsHub token/],
        [403, /doesn't control the account the money comes from/],
        [409, /already has a payment under this ID with different details/],
        [422, /refused the payment/],
      ];
      for (const [status, words] of cases) {
        answers = [json(status, {})];
        const out = await client().pay(payment());
        assert.equal(out.ok, false, String(status));
        assert.equal((out as { status: number }).status, status);
        assert.match((out as { reason: string }).reason, words, String(status));
      }
      assert.equal(calls.length, cases.length, 'each was one request: a refusal is never tried again');
    });

    it('adds what Aeroconomy said, from its message or its first error', async () => {
      answers = [json(422, { message: 'The given data was invalid.', errors: { lines: ['Insufficient funds.'] } })];
      assert.match((await client().pay(payment()) as { reason: string }).reason, /It said: Insufficient funds\./);
      answers = [json(422, { message: 'Account 2002-9999999 does not exist.' })];
      assert.match((await client().pay(payment()) as { reason: string }).reason, /It said: Account 2002-9999999 does not exist\./);
    });

    it('shows only text that is safe: one line, no control characters, and not too long', async () => {
      answers = [json(422, { message: `Bad\n\u0000thing ${'y'.repeat(500)}` })];
      const reason = (await client().pay(payment()) as { reason: string }).reason;
      assert.doesNotMatch(reason, /[\u0000-\u001f]/);
      assert.ok(reason.length < 400, `${reason.length}`);
    });

    it('copes with an error that is not JSON, or an unusual status', async () => {
      answers = [new Response('<html>gone</html>', { status: 422 })];
      assert.match((await client().pay(payment()) as { reason: string }).reason, /refused the payment/);
      answers = [json(418, {})];
      const out = await client().pay(payment());
      assert.equal(out.ok, false);
      assert.match((out as { reason: string }).reason, /\(418\)/);
    });
  });

  describe('when it is told to slow down', () => {
    it('waits as long as it was asked (at most a minute) and sends the same payment again under the same ID', async () => {
      answers = [json(429, {}, { 'retry-after': '3' }), json(429, {}, { 'retry-after': '500' }), good()];
      const out = await client().pay(payment());
      assert.equal(out.ok, true);
      assert.deepEqual(waits, [3000, 60_000]);
      assert.equal(calls.length, 3);
      assert.deepEqual([...new Set(calls.map((c) => c.init.headers['idempotency-key']))], ['fpb-test-0011223344556677'], 'every try carries the same key');
    });

    it('gives up after three tries, and says nothing was sent', async () => {
      answers = [json(429, {}), json(429, {}), json(429, {})];
      const out = await client().pay(payment());
      assert.equal(out.ok, false);
      assert.match((out as { reason: string }).reason, /slow down[^]*Nothing was sent/);
      assert.equal(calls.length, 3);
    });
  });

  describe('when there is no answer, and nobody can know whether the money moved', () => {
    it('sends it again with the same key when the network drops, which Aeroconomy answers with the original if it had been taken', async () => {
      answers = [new Error('fetch failed'), new Error('fetch failed'), good({}, { 'idempotent-replayed': 'true' })];
      const out = await client().pay(payment());
      assert.equal(out.ok && out.replayed, true);
      assert.deepEqual(waits, [2000, 4000]);
      assert.deepEqual([...new Set(calls.map((c) => c.init.headers['idempotency-key']))], ['fpb-test-0011223344556677']);
    });

    it('throws, and does not call it refused, when it still has no answer after three tries', async () => {
      answers = [new Error('a'), new Error('b'), new Error('c')];
      await assert.rejects(client().pay(payment()), (e: unknown) => e instanceof AeroconomyError && /nobody knows whether the money moved/.test(e.message));
      assert.equal(calls.length, 3);
    });

    it('treats a timeout the same way', async () => {
      answers = [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), good()];
      assert.equal((await client().pay(payment())).ok, true);
      assert.equal(calls.length, 2);
    });

    it('sends it again on a server error, and throws if the server is still in error', async () => {
      answers = [json(503, {}), good()];
      assert.equal((await client().pay(payment())).ok, true);
      answers = [json(500, {}), json(502, {}), json(500, {})];
      await assert.rejects(client().pay(payment()), (e: unknown) => e instanceof AeroconomyError && e.status === 500 && /nobody knows/.test(e.message));
    });

    it('throws, and does not follow it, for a redirect', async () => {
      answers = [new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })];
      await assert.rejects(client().pay(payment()), (e: unknown) => e instanceof AeroconomyError && /redirect/.test(e.message));
      assert.equal(calls.length, 1);
    });
  });

  describe('when the answer says it worked but is not the payment that was sent', () => {
    it('throws for a different amount, and for a different recipient, rather than call it paid', async () => {
      answers = [good({ total: '100.00' })];
      await assert.rejects(client().pay(payment()), (e: unknown) => e instanceof AeroconomyError && /different amount/.test(e.message));
      answers = [good({ recipient: '2002-9999999' })];
      await assert.rejects(client().pay(payment()), (e: unknown) => e instanceof AeroconomyError && /different recipient/.test(e.message));
    });

    it('throws for an answer that is not JSON, or says nothing about the payment', async () => {
      answers = [new Response('created', { status: 201 })];
      await assert.rejects(client().pay(payment()), /cannot confirm/);
      answers = [json(201, {})];
      await assert.rejects(client().pay(payment()), /did not say what it was/);
      answers = [json(201, [])];
      await assert.rejects(client().pay(payment()), /cannot confirm/);
    });

    it('is not fooled by an amount written as a number, or with extra zeros', async () => {
      answers = [json(201, { data: { id: 1, total_amount: 1, recipient: { account_number: RECIPIENT } } })];
      assert.equal((await client().pay(payment())).ok, true);
      answers = [json(201, { data: { id: 1, total_amount: '1.0000', recipient: { account_number: RECIPIENT } } })];
      assert.equal((await client().pay(payment())).ok, true);
    });
  });

  describe('what it leaves in the log', () => {
    it('never the token, and an account only by its last four characters', async () => {
      answers = [good(), json(422, { message: 'nope' }), new Error('x'), new Error('y'), new Error('z')];
      await client().pay(payment());
      await client().pay(payment({ idempotencyKey: 'another-key-1' }));
      await client().pay(payment({ idempotencyKey: 'another-key-2' })).catch(() => undefined);
      const all = logs.join('\n');
      assert.doesNotMatch(all, /TEST-TOKEN/);
      assert.doesNotMatch(all, /9954-0000123/);
      assert.doesNotMatch(all, /2002-0004567/);
      assert.match(all, /…0123 to …4567/);
    });
  });
});

describe('the gateway behind the payroll', () => {
  let sent: PaymentRequest[];
  let reply: Awaited<ReturnType<AeroconomyPaymentsClient['pay']>> | Error;
  const gateway = () =>
    new AeroconomyGateway({
      pay: async (p) => {
        sent.push(p);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
  const request = (over: Partial<PayRequest> = {}): PayRequest => ({ sourceAccount: SOURCE, recipientAccount: RECIPIENT, uniqueId: '32411-KORD-EGLL-111926', cents: 812_500, description: 'Pilot pay', ...over });

  beforeEach(() => {
    sent = [];
    reply = { ok: true, transactionId: 9134, replayed: false, balanceCents: 123_400 };
  });

  it('is connected', () => {
    assert.equal(gateway().connected, true);
  });

  it('sends the payment\'s unique ID as the idempotency key, with the accounts, the amount and the description', async () => {
    await gateway().pay(request());
    assert.deepEqual(sent, [{ idempotencyKey: '32411-KORD-EGLL-111926', sourceAccount: SOURCE, recipientAccount: RECIPIENT, description: 'Pilot pay', cents: 812_500 }]);
  });

  it('answers that it was taken, with Aeroconomy\'s number for it and the balance', async () => {
    assert.deepEqual(await gateway().pay(request()), { ok: true, reference: '9134', balanceCents: 123_400 });
    reply = { ok: true, transactionId: null, replayed: true, balanceCents: null };
    assert.deepEqual(await gateway().pay(request()), { ok: true, reference: null, balanceCents: null });
  });

  it('answers that it was refused, with the reason, so the payroll leaves it unpaid', async () => {
    reply = { ok: false, status: 422, reason: 'Aeroconomy refused the payment. It said: Insufficient funds.' };
    assert.deepEqual(await gateway().pay(request()), { ok: false, reason: 'Aeroconomy refused the payment. It said: Insufficient funds.' });
  });

  it('lets "no answer" through as the error it is, for the payroll to leave as sent-and-unconfirmed', async () => {
    reply = new AeroconomyError('no answer');
    await assert.rejects(gateway().pay(request()), /no answer/);
  });

  it('refuses an amount the bot will never send, before asking Aeroconomy', async () => {
    for (const cents of [0, -5, 1.5, Number.NaN, MAX_PAYMENT_CENTS + 1]) {
      const out = await gateway().pay(request({ cents }));
      assert.equal(out.ok, false, String(cents));
    }
    assert.deepEqual(sent, []);
    assert.equal((await gateway().pay(request({ cents: MAX_PAYMENT_CENTS }))).ok, true, 'the cap itself is allowed');
  });
});
