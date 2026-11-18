import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRedisStore } from '../src/store/redis.mjs';

const endpoint = 'https://example.upstash.io';

test('Redis transport preserves strings, maps null fields, and uses authenticated atomic commands', async t => {
  const requests = [];
  const text = '\n  <script>alert("literal")</script>\r\nनमस्ते 🌏\u0000\ud800';
  const answers = ['PONG', 1, [JSON.stringify(text), '', ''], 0, null];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), `${endpoint}/`);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    requests.push(JSON.parse(options.body));
    return Response.json({ result: answers.shift() });
  });
  const store = createRedisStore({ url: endpoint, token: 'test-token' });
  assert.equal(await store.health(), true);
  assert.equal(await store.create({ id: 'sample', content: text, expiresAt: null, maxViews: null }), true);
  assert.deepEqual(await store.consume('sample', 1000), {
    content: text, remaining_views: null, expires_at: null,
  });
  assert.equal(await store.create({ id: 'sample', content: 'replacement', expiresAt: null, maxViews: null }), false);
  assert.equal(await store.consume('missing', 1000), null);
  assert.equal(requests[1][0], 'EVAL');
  assert.equal(requests[2][0], 'EVAL');
  assert.equal(requests[1][3], 'pastebin:sample');
  assert.equal(requests[1][4], JSON.stringify(text));
  assert.equal(requests.length, 5);
});

test('Redis failures are sanitized and consuming requests are never retried', async t => {
  for (const response of [
    () => Response.json({ error: 'upstream-internal-secret' }, { status: 401 }),
    () => Response.json({ error: 'upstream-internal-secret' }),
    () => Response.json({ unexpected: true }),
    () => new Response('<html>upstream-internal-secret</html>'),
    () => { throw new Error('upstream-internal-secret'); },
  ]) {
    let attempts = 0;
    const stub = t.mock.method(globalThis, 'fetch', async () => {
      attempts += 1;
      return response();
    });
    const store = createRedisStore({ url: endpoint, token: 'test-secret-token' });
    await assert.rejects(store.consume('sample', 1000), {
      message: 'Persistence service is unavailable.',
    });
    assert.equal(attempts, 1);
    assert.equal(await store.health(), false);
    stub.mock.restore();
  }
});

test('Redis configuration rejects insecure or credential-bearing endpoints', () => {
  for (const url of ['http://example.upstash.io', 'invalid', 'https://user:secret@example.upstash.io', `${endpoint}/?token=secret`]) {
    assert.throws(() => createRedisStore({ url, token: 'test-token' }));
  }
  assert.throws(() => createRedisStore({ url: endpoint, token: '' }));
});

// Opt in with REDIS_INTEGRATION=1 and UPSTASH_REDIS_REST_URL/TOKEN. Only
// random, namespaced test keys are created; no existing application data is read.
test('real Redis: atomic limits, expiry, persistence across clients, and literal content', {
  skip: process.env.REDIS_INTEGRATION !== '1',
}, async t => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prefix = `pastebin-test:${randomUUID()}:`;
  const config = { url, token, prefix };
  const store = createRedisStore(config);
  const otherClient = createRedisStore(config);
  const ids = [];
  const make = async (values = {}) => {
    const paste = { id: randomUUID(), content: 'hello', expiresAt: null, maxViews: null, ...values };
    ids.push(paste.id);
    assert.equal(await store.create(paste), true);
    return paste;
  };
  t.after(async () => {
    if (!ids.length) return;
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['DEL', ...ids.map(id => prefix + id)]),
      signal: AbortSignal.timeout(4000), redirect: 'error',
    });
    assert.equal(response.ok, true, 'Test key cleanup should succeed.');
  });
  assert.equal(await store.health(), true);
  const text = '\n<script>literal & safe</script>\r\nनमस्ते 🌏\u0000\ud800\n'.repeat(1000);
  const unlimited = await make({ content: text });
  assert.equal(await store.create({ ...unlimited, content: 'replacement' }), false);
  assert.deepEqual(await otherClient.consume(unlimited.id, Date.now()), {
    content: text, remaining_views: null, expires_at: null,
  });
  const limited = await make({ maxViews: 3 });
  const reads = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    (i % 2 ? store : otherClient).consume(limited.id, Date.now())));
  assert.deepEqual(reads.filter(Boolean).map(paste => paste.remaining_views).sort(), [0, 1, 2]);
  assert.equal(await store.consume(limited.id, Date.now()), null);
  const expiry = 1_900_000_000_000;
  const expiring = await make({ expiresAt: expiry });
  assert.equal((await store.consume(expiring.id, expiry - 1)).expires_at, new Date(expiry).toISOString());
  assert.equal(await otherClient.consume(expiring.id, expiry), null);
  assert.equal(await store.consume(expiring.id, expiry - 1), null, 'Observed expiry must not resurrect when the clock moves back.');
  const combined = await make({ expiresAt: expiry, maxViews: 1 });
  assert.equal((await store.consume(combined.id, expiry - 1)).remaining_views, 0);
  assert.equal(await otherClient.consume(combined.id, expiry - 1), null);
  const combinedExpiry = await make({ expiresAt: expiry, maxViews: 5 });
  assert.equal(await store.consume(combinedExpiry.id, expiry), null);
});
