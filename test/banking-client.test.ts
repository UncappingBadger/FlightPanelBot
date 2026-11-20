import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AeroconomyBankingClient, isAccountNumber } from '../src/aeroconomy/banking.js';
import { AEROCONOMY_API } from '../src/aeroconomy/client.js';
import { AeroconomyError } from '../src/aeroconomy/http.js';
import { SecretBox } from '../src/services/secretBox.js';

const TOKEN = 'fsh-secret-token-0123456789abcdef';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/* ------------------------------------------------------------------ keeping a token sealed */

describe('sealing a secret', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-box-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives the secret back, and is nothing like it while sealed', () => {
    const box = SecretBox.inMemory();
    const sealed = box.seal(TOKEN);
    assert.equal(box.open(sealed), TOKEN);
    assert.ok(!sealed.includes(TOKEN) && !Buffer.from(sealed.split(':')[3] ?? '', 'base64').toString('utf8').includes('secret'));
    assert.match(sealed, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  it('seals the same secret differently each time', () => {
    const box = SecretBox.inMemory();
    assert.notEqual(box.seal(TOKEN), box.seal(TOKEN));
  });

  it('refuses to open what was changed, what another key sealed, and what is not sealed at all', () => {
    const box = SecretBox.inMemory();
    const sealed = box.seal(TOKEN);
    const parts = sealed.split(':');
    const flipped = [parts[0], parts[1], parts[2], Buffer.from(Buffer.from(parts[3]!, 'base64').map((b, i) => (i === 0 ? b ^ 1 : b))).toString('base64')].join(':');
    assert.equal(box.open(flipped), null, 'a changed byte');
    assert.equal(SecretBox.inMemory().open(sealed), null, 'another key');
    for (const bad of ['', null, undefined, 'plain', 'v1:a:b', 'v2:a:b:c', `${sealed}:extra`, 'v1:%%%:%%%:%%%']) assert.equal(box.open(bad as string), null, String(bad));
  });

  it('keeps its key in a file, made once and used again by the next start', () => {
    const path = join(dir, 'sub', 'banking.key');
    const a = SecretBox.fromFile(path);
    assert.ok(existsSync(path));
    assert.match(readFileSync(path, 'utf8').trim(), /^[0-9a-f]{64}$/);
    const sealed = a.seal(TOKEN);
    assert.equal(SecretBox.fromFile(path).open(sealed), TOKEN, 'the next start opens what the last one sealed');
    assert.equal(SecretBox.fromFile(join(dir, 'other.key')).open(sealed), null, 'a different key file does not');
  });

  it('refuses a key file that is not a key, rather than sealing with something weak', () => {
    const path = join(dir, 'banking.key');
    writeFileSync(path, 'not a key');
    assert.throws(() => SecretBox.fromFile(path), /not a key/);
  });
});

/* ------------------------------------------------------------------ reading accounts and payments */

describe('reading a pilot\'s Aeroconomy bank accounts', () => {
  let calls: Array<{ url: string; headers: Record<string, string>; method?: string; redirect?: string }>;
  let reply: (url: string) => Response;
  let client: AeroconomyBankingClient;
  beforeEach(() => {
    calls = [];
    reply = () => json({}, 404);
    client = new AeroconomyBankingClient({
      fetchFn: (async (input: unknown, init?: RequestInit) => (calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string>, method: init?.method, redirect: init?.redirect }), reply(String(input)))) as typeof fetch,
      gapMs: 0,
    });
  });

  const tx = (over: Record<string, unknown> = {}) => ({
    id: 9134,
    created_at: '2026-10-19T12:45:30+00:00',
    direction: 'debit',
    description: 'Fuel reimbursement',
    total_amount: '1250.00',
    sender: { account_number: '9954-0000123', account_name: 'Example Air Logistics' },
    recipient: { account_number: '7731-0000184', account_name: 'Example Pilot' },
    lines: [
      { description: 'Jet A-1', amount: '1000.00' },
      { description: 'Handling', amount: '250.00' },
    ],
    ...over,
  });

  it('sends the token only as a bearer header, to Aeroconomy, as a plain GET that never follows a redirect', async () => {
    reply = () => json({ data: [] });
    await client.accounts(TOKEN);
    await client.transactions(TOKEN, '9954-0000123', { limit: 10 });
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.method, 'GET');
      assert.equal(c.redirect, 'manual');
      assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
      assert.ok(c.url.startsWith(`${AEROCONOMY_API}/banking/`));
      assert.ok(!c.url.includes(TOKEN), 'never in an address');
    }
    assert.deepEqual(calls.map((c) => c.url.replace(AEROCONOMY_API, '')), ['/banking/accounts', '/banking/accounts/9954-0000123/transactions?limit=10']);
  });

  it('lists the accounts it can see: number, name and kind, leaving out one it cannot read', async () => {
    reply = () =>
      json({
        data: [
          { account_number: '2002-0000111', account_name: '  Alex   Personal ', account_type: 'personal', balance: '10.00' },
          { account_number: '9954-0000123', account_name: 'Example Air Logistics', account_type: 'business' },
          { account_number: '9954-0000123', account_name: 'Again' },
          { account_number: '../x', account_name: 'Bad number' },
          { account_name: 'No number' },
          { account_number: '7731-0000184', account_name: null, account_type: null },
          'nonsense',
        ],
        meta: { count: 7 },
      });
    assert.deepEqual(await client.accounts(TOKEN), [
      { number: '2002-0000111', name: 'Alex Personal', type: 'personal' },
      { number: '9954-0000123', name: 'Example Air Logistics', type: 'business' },
      { number: '7731-0000184', name: '7731-0000184', type: null },
    ]);
    reply = () => json({}, 404);
    assert.deepEqual(await client.accounts(TOKEN), []);
    reply = () => json({ data: 'many' });
    await assert.rejects(client.accounts(TOKEN), (e: unknown) => e instanceof AeroconomyError);
  });

  it('says which answer an error was about: a refusal of the token is a 401, of the account a 403 or 404', async () => {
    reply = () => json({ message: 'no' }, 401);
    await assert.rejects(client.accounts(TOKEN), (e: unknown) => e instanceof AeroconomyError && e.status === 401 && !e.message.includes(TOKEN));
    reply = () => json({ message: 'no' }, 403);
    await assert.rejects(client.transactions(TOKEN, '9954-0000123'), (e: unknown) => e instanceof AeroconomyError && e.status === 403);
    reply = () => json({}, 404);
    await assert.rejects(client.transactions(TOKEN, '9954-0000123'), (e: unknown) => e instanceof AeroconomyError && e.status === 404);
    reply = () => json({}, 500);
    await assert.rejects(client.transactions(TOKEN, '9954-0000123'), (e: unknown) => e instanceof AeroconomyError && e.status === 500);
  });

  it('reads a payment: its number, time, direction, both sides, the total and its lines', async () => {
    reply = () => json({ data: [tx()], meta: { account_number: '9954-0000123', limit: 25, next_cursor: 9102, has_more: true } });
    const page = await client.transactions(TOKEN, '9954-0000123');
    assert.deepEqual(page, {
      transactions: [
        {
          id: 9134,
          at: Date.parse('2026-10-19T12:45:30+00:00'),
          direction: 'debit',
          description: 'Fuel reimbursement',
          amount: 1250,
          sender: { number: '9954-0000123', name: 'Example Air Logistics' },
          recipient: { number: '7731-0000184', name: 'Example Pilot' },
          lines: [
            { description: 'Jet A-1', amount: 1000 },
            { description: 'Handling', amount: 250 },
          ],
        },
      ],
      hasMore: true,
      nextCursor: 9102,
    });
  });

  it('is lenient about what is odd in one payment, and leaves out one it cannot use', async () => {
    reply = () =>
      json({
        data: [
          tx({ id: 5, direction: 'sideways', description: '  ', total_amount: 12.5, sender: false, recipient: { account_number: '??', account_name: 'X' }, lines: ['a', { amount: 'x' }, { description: 'ok', amount: 1 }], created_at: 'not a date' }),
          tx({ id: 6, total_amount: 'lots' }),
          tx({ id: 'seven' }),
          tx({ id: 0 }),
          'nonsense',
        ],
      });
    const page = await client.transactions(TOKEN, '9954-0000123');
    assert.deepEqual(page.transactions, [{ id: 5, at: null, direction: null, description: null, amount: 12.5, sender: null, recipient: { number: null, name: 'X' }, lines: [{ description: 'ok', amount: 1 }] }]);
    assert.deepEqual([page.hasMore, page.nextCursor], [false, null], 'no paging information means no more');
  });

  it('asks for a page of the size wanted, and for older ones from a payment number', async () => {
    reply = () => json({ data: [] });
    await client.transactions(TOKEN, '9954-0000123', { limit: 500 });
    await client.transactions(TOKEN, '9954-0000123', { limit: 0 });
    await client.transactions(TOKEN, '9954-0000123', { limit: 50, beforeId: 9102 });
    await client.transactions(TOKEN, '9954-0000123', { beforeId: null });
    assert.deepEqual(calls.map((c) => c.url.replace(`${AEROCONOMY_API}/banking/accounts/9954-0000123/transactions`, '')), ['?limit=100', '?limit=1', '?limit=50&before_id=9102', '?limit=25']);
  });

  it('only ever puts a real account number in an address', async () => {
    for (const bad of ['', '../accounts', '9954/0000123', '9954-0000123?x=1', 'a b', 'x'.repeat(60), '..']) {
      await assert.rejects(client.transactions(TOKEN, bad), (e: unknown) => e instanceof AeroconomyError && e.status === 404, bad);
    }
    assert.equal(calls.length, 0);
    assert.ok(isAccountNumber('9954-0000123') && isAccountNumber('7731-0000184') && !isAccountNumber('9954 0000123'));
  });
});
