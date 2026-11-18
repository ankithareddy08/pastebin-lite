import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const testNow = Date.UTC(2032, 0, 1);
let directory;
let databasePath;
let server;

async function startServer(testMode = '1') {
  const env = {
    ...process.env, PORT: '0', DATABASE_PATH: databasePath, TEST_MODE: testMode, STORAGE_DRIVER: 'sqlite',
    APP_BASE_URL: '', TRUST_PROXY: '0', HOST: '127.0.0.1',
  };
  // Keep the contract suite independent of a developer's production credentials.
  for (const key of [
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'REDIS_REST_URL', 'REDIS_REST_TOKEN',
    'VERCEL', 'BASE_URL', 'APP_URL', 'PUBLIC_BASE_URL',
  ]) delete env[key];
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let logs = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { logs += chunk; });
  child.stdout.setEncoding('utf8');
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Server startup timed out. ${logs}`));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stdout.removeListener('data', onData);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Server exited before listening (${code}). ${logs}`));
    };
    const onData = (chunk) => {
      logs += chunk;
      const match = logs.match(/Listening on port (\d+)/);
      if (match) { cleanup(); resolve(Number(match[1])); }
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', onData);
  });
  const origin = new URL('http:' + '//127.0.0.1');
  origin.port = String(port);
  return { child, origin: origin.origin };
}

async function stopServer(instance) {
  if (!instance || instance.child.exitCode !== null || instance.child.signalCode !== null) return;
  const closed = once(instance.child, 'close');
  instance.child.kill();
  await closed;
}

function request(path, options = {}) {
  return fetch(new URL(path, server.origin), {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });
}

async function json(response) {
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  return response.json();
}

async function create(body, now) {
  const headers = { 'Content-Type': 'application/json' };
  if (now !== undefined) headers['x-test-now-ms'] = String(now);
  const response = await request('/api/pastes', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const result = await json(response);
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(result));
  assert.equal(typeof result.id, 'string');
  assert.ok(result.id.length > 0);
  const link = new URL(result.url);
  assert.equal(link.origin, server.origin);
  assert.equal(link.pathname, `/p/${result.id}`);
  return result;
}

function fetchPaste(id, now) {
  return request(`/api/pastes/${id}`, now === undefined ? {} : {
    headers: { 'x-test-now-ms': String(now) },
  });
}

async function assertMissing(response) {
  assert.equal(response.status, 404);
  const body = await json(response);
  assert.ok(body && typeof body === 'object');
  assert.ok(body.error, 'Unavailable pastes should include a useful JSON error.');
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pastebin-lite-test-'));
  databasePath = join(directory, 'pastes.sqlite');
  server = await startServer();
});

after(async () => {
  await stopServer(server);
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('health check returns HTTP 200 and valid JSON', async () => {
  const response = await request('/api/healthz');
  assert.equal(response.status, 200);
  assert.equal((await json(response)).ok, true);
});

test('creation returns a unique id and a shareable URL on this application', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => create({ content: 'same text' })));
  assert.equal(new Set(results.map((paste) => paste.id)).size, results.length);
});

test('unlimited pastes preserve arbitrary text and report nullable constraints', async () => {
  const content = '  first line\nsecond line\t\n<hello> & "quotes" \'apostrophe\' 😀 नमस्ते\n';
  const { id } = await create({ content });
  for (let read = 0; read < 3; read++) {
    const response = await fetchPaste(id);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
    assert.deepEqual(await json(response), { content, remaining_views: null, expires_at: null });
  }
});

test('API text round-trip preserves embedded NUL and unpaired UTF-16 surrogates', async () => {
  const content = 'before\u0000after\nlead:\ud800:end\ntrail:\udc00:end\nemoji:😀';
  const { id } = await create({ content });
  const response = await fetchPaste(id);
  assert.equal(response.status, 200);
  assert.equal((await json(response)).content, content);
});

test('whitespace is non-empty text and is preserved without trimming', async () => {
  const content = ' \n\t ';
  const { id } = await create({ content });
  assert.equal((await json(await fetchPaste(id))).content, content);
});

test('invalid create payloads return a 4xx JSON error', async (t) => {
  const cases = [
    ['missing content', {}], ['empty content', { content: '' }],
    ['numeric content', { content: 42 }], ['null content', { content: null }],
    ['object content', { content: {} }], ['array body', []], ['null body', null],
    ...['ttl_seconds', 'max_views'].flatMap((field) => [0, -1, 1.5, '2', null, true, [], {}]
      .map((value) => [`${field}=${JSON.stringify(value)}`, { content: 'example', [field]: value }])),
  ];
  for (const [name, body] of cases) {
    await t.test(name, async () => {
      const response = await request('/api/pastes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.ok(response.status >= 400 && response.status < 500, `Unexpected status: ${response.status}`);
      assert.ok((await json(response)).error);
    });
  }
  await t.test('malformed JSON', async () => {
    const response = await request('/api/pastes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"content":',
    });
    assert.ok(response.status >= 400 && response.status < 500);
    assert.ok((await json(response)).error);
  });
});

test('max_views=1 and max_views=2 allow exactly the stated number of reads', async () => {
  for (const limit of [1, 2]) {
    const { id } = await create({ content: `Read me ${limit} times`, max_views: limit });
    for (let index = 0; index < limit; index++) {
      const response = await fetchPaste(id);
      assert.equal(response.status, 200);
      const result = await json(response);
      assert.equal(result.remaining_views, limit - index - 1);
      assert.equal(result.expires_at, null);
    }
    await assertMissing(await fetchPaste(id));
    await assertMissing(await fetchPaste(id));
  }
});

test('test clock supports TTL immediately before and exactly at expiry', async () => {
  const { id } = await create({ content: 'Time limited', ttl_seconds: 60 }, testNow);
  const beforeExpiry = await fetchPaste(id, testNow + 59_999);
  assert.equal(beforeExpiry.status, 200);
  assert.deepEqual(await json(beforeExpiry), {
    content: 'Time limited', remaining_views: null,
    expires_at: new Date(testNow + 60_000).toISOString(),
  });
  await assertMissing(await fetchPaste(id, testNow + 60_000));
  await assertMissing(await fetchPaste(id, testNow + 60_001));
});

test('an observed expiry remains unavailable if the test clock moves backwards', async () => {
  for (const limits of [{ ttl_seconds: 1 }, { ttl_seconds: 1, max_views: 3 }]) {
    const { id } = await create({ content: 'Expired permanently', ...limits }, testNow);
    assert.equal((await fetchPaste(id, testNow)).status, 200);
    await assertMissing(await fetchPaste(id, testNow + 1_000));
    await assertMissing(await fetchPaste(id, testNow));
    const html = await request(`/p/${id}`, { headers: { 'x-test-now-ms': String(testNow) } });
    assert.equal(html.status, 404);
  }
});

test('test mode uses real time when the test header is absent', async () => {
  const before = Date.now();
  const { id } = await create({ content: 'Real clock fallback', ttl_seconds: 60 });
  const after = Date.now();
  const response = await fetchPaste(id);
  assert.equal(response.status, 200);
  const expiresAt = Date.parse((await json(response)).expires_at);
  assert.ok(expiresAt >= before + 60_000);
  assert.ok(expiresAt <= after + 60_000);
  await assertMissing(await fetchPaste(id, expiresAt));
});

test('combined constraints stop access when either limit is reached first', async () => {
  const viewsFirst = await create({ content: 'Views first', ttl_seconds: 60, max_views: 1 }, testNow);
  const lastView = await fetchPaste(viewsFirst.id, testNow + 1);
  assert.equal(lastView.status, 200);
  assert.equal((await json(lastView)).remaining_views, 0);
  await assertMissing(await fetchPaste(viewsFirst.id, testNow + 2));

  const timeFirst = await create({ content: 'Time first', ttl_seconds: 1, max_views: 5 }, testNow);
  assert.equal((await fetchPaste(timeFirst.id, testNow)).status, 200);
  await assertMissing(await fetchPaste(timeFirst.id, testNow + 1_000));
});

test('missing pastes return JSON 404 through the API and HTML 404 through the browser route', async () => {
  await assertMissing(await fetchPaste('missing-paste-for-contract-test'));
  const response = await request('/p/missing-paste-for-contract-test');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i);
  assert.ok((await response.text()).length > 0);
});

test('HTML view safely renders text and consumes exactly one view', async () => {
  const content = '<script>alert("unsafe")</script>\n<img src=x onerror="alert(1)">\n& some text';
  const { id } = await create({ content, max_views: 2 });
  const response = await request(`/p/${id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  const html = await response.text();
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&amp; some text'));
  assert.ok(!html.includes('<script>alert("unsafe")</script>'));
  assert.ok(!html.includes('<img src=x'));
  const lastView = await fetchPaste(id);
  assert.equal(lastView.status, 200);
  assert.equal((await json(lastView)).remaining_views, 0);
  assert.equal((await request(`/p/${id}`)).status, 404);
});

test('HTML route honors the deterministic expiry boundary', async () => {
  const { id } = await create({ content: 'Visible in HTML', ttl_seconds: 2 }, testNow);
  const response = await request(`/p/${id}`, { headers: { 'x-test-now-ms': String(testNow + 1_999) } });
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('Visible in HTML'));
  assert.equal((await request(`/p/${id}`, {
    headers: { 'x-test-now-ms': String(testNow + 2_000) },
  })).status, 404);
});

test('concurrent API reads never exceed a view limit or return negative remaining views', async () => {
  const { id } = await create({ content: 'Only five readers', max_views: 5 });
  const responses = await Promise.all(Array.from({ length: 20 }, () => fetchPaste(id)));
  const successful = responses.filter((response) => response.status === 200);
  assert.equal(successful.length, 5);
  const remaining = await Promise.all(successful.map(async (response) => (await json(response)).remaining_views));
  assert.deepEqual(remaining.sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  for (const response of responses.filter((response) => response.status !== 200)) await assertMissing(response);
});

test('API and HTML requests share one atomic view limit', async () => {
  const { id } = await create({ content: 'Shared counter', max_views: 3 });
  const responses = await Promise.all(Array.from({ length: 16 }, (_, index) => (
    index % 2 === 0 ? fetchPaste(id) : request(`/p/${id}`)
  )));
  assert.equal(responses.filter((response) => response.status === 200).length, 3);
  assert.ok(responses.every((response) => response.status === 200 || response.status === 404));
  await Promise.all(responses.map((response) => response.text()));
});

test('separate server processes share durable view counts without overserving', async () => {
  const { id } = await create({ content: 'Shared between processes', max_views: 4 });
  const otherServer = await startServer();
  try {
    const responses = await Promise.all(Array.from({ length: 16 }, (_, index) => fetch(
      new URL(`/api/pastes/${id}`, index % 2 === 0 ? server.origin : otherServer.origin),
      { signal: AbortSignal.timeout(10_000) },
    )));
    const successful = responses.filter((response) => response.status === 200);
    assert.equal(successful.length, 4);
    const remaining = await Promise.all(successful.map(async (response) => (await json(response)).remaining_views));
    assert.deepEqual(remaining.sort((a, b) => a - b), [0, 1, 2, 3]);
    for (const response of responses.filter((response) => response.status !== 200)) await assertMissing(response);
  } finally {
    await stopServer(otherServer);
  }
});

test('pastes, expiry and consumed view counts survive a server restart', async () => {
  const { id } = await create({ content: 'Persistent text', max_views: 2, ttl_seconds: 120 }, testNow);
  assert.equal((await json(await fetchPaste(id, testNow))).remaining_views, 1);
  await stopServer(server);
  server = await startServer();
  const response = await fetchPaste(id, testNow + 1);
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), {
    content: 'Persistent text', remaining_views: 0,
    expires_at: new Date(testNow + 120_000).toISOString(),
  });
  await assertMissing(await fetchPaste(id, testNow + 2));
});

test('normal mode ignores the test-time header during both creation and retrieval', async () => {
  await stopServer(server);
  server = await startServer('0');
  const before = Date.now();
  const { id } = await create({ content: 'Production clock', ttl_seconds: 60 }, 0);
  const after = Date.now();
  const response = await fetchPaste(id, testNow + 1_000_000);
  assert.equal(response.status, 200);
  const expiry = Date.parse((await json(response)).expires_at);
  assert.ok(expiry >= before + 60_000 && expiry <= after + 60_000);
});
