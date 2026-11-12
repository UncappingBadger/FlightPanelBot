import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTextCapped } from '../src/util/http.js';

/** A body of `chunks`, handed out one at a time, that records whether the reader gave up on it and how many chunks it was asked for. */
function stream(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const seen = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      seen.pulled++;
      controller.enqueue(chunks[i++]!);
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { res: new Response(body, { headers }), seen };
}
const bytes = (s: string) => new TextEncoder().encode(s);

describe('reading a response body with a cap', () => {
  it('returns the whole text when it is within the cap', async () => {
    assert.equal(await readTextCapped(new Response('hello world'), 100), 'hello world');
  });

  it('returns an empty string for an empty body', async () => {
    assert.equal(await readTextCapped(new Response(''), 10), '');
    assert.equal(await readTextCapped(new Response(null, { status: 204 }), 10), '');
  });

  it('accepts a body exactly the size of the cap and refuses one byte more', async () => {
    assert.equal(await readTextCapped(new Response('x'.repeat(10)), 10), 'x'.repeat(10));
    assert.equal(await readTextCapped(new Response('x'.repeat(11)), 10), null);
  });

  it('refuses at once, without reading, when the server says it is too long', async () => {
    const { res, seen } = stream([bytes('x'.repeat(50))], { 'content-length': '5000000' });
    assert.equal(await readTextCapped(res, 1000), null);
    assert.equal(seen.pulled, 0, 'not one chunk was read');
    assert.equal(seen.cancelled, true, 'and the connection was given up on');
  });

  it('stops reading as soon as the body turns out to be too long when the server did not say how long it is', async () => {
    const chunks = Array.from({ length: 1000 }, () => bytes('x'.repeat(100)));
    const { res, seen } = stream(chunks);
    assert.equal(await readTextCapped(res, 450), null);
    assert.ok(seen.pulled < 20, `${seen.pulled} chunks were read, not all 1000`);
    assert.equal(seen.cancelled, true);
  });

  it('is not fooled by a server that understates its length', async () => {
    const { res } = stream([bytes('x'.repeat(100)), bytes('x'.repeat(100))], { 'content-length': '10' });
    assert.equal(await readTextCapped(res, 150), null);
  });

  it('joins a character that arrives split across chunks', async () => {
    const euro = bytes('€'); // three bytes
    const { res } = stream([bytes('a'), euro.slice(0, 1), euro.slice(1), bytes('b')]);
    assert.equal(await readTextCapped(res, 100), 'a€b');
  });

  it('counts bytes, not characters, against the cap', async () => {
    assert.equal(await readTextCapped(new Response('€€€'), 9), '€€€');
    assert.equal(await readTextCapped(new Response('€€€'), 8), null);
  });
});
