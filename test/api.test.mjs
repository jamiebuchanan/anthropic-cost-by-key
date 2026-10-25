import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, nextDay, ApiError } from '../src/api.mjs';
import { createFakeApi } from './fake-api.mjs';

const window = { since: '2026-10-01', until: '2026-10-03' };
const noSleep = async () => {};
const clientFor = (api, extra = {}) => createClient({ adminKey: api.adminKey, baseUrl: 'https://fake.invalid', fetchImpl: api.fetchImpl, sleep: noSleep, ...extra });

test('report pages are followed with next_page until has_more is false', async () => {
  const api = createFakeApi({ pageSize: 2 });
  const buckets = await clientFor(api).usageReport(window);
  assert.equal(buckets.length, 3);
  assert.deepEqual(buckets.map((b) => b.starting_at.slice(0, 10)), ['2026-10-01', '2026-10-02', '2026-10-03']);
  const pages = api.requests.filter((r) => r.path.endsWith('/messages'));
  assert.equal(pages.length, 2);
  assert.equal(pages[0].query.get('page'), null);
  assert.equal(pages[1].query.get('page'), 'page_2');
});

test('requests carry the admin key header and the API version, and ask for the right grouping', async () => {
  const api = createFakeApi();
  await clientFor(api).usageReport(window);
  const first = api.requests[0];
  assert.equal(first.headers['x-api-key'], 'test-admin-key');
  assert.equal(first.headers['anthropic-version'], '2023-06-01');
  assert.match(first.headers['user-agent'], /^anthropic-cost-by-key\//);
  assert.deepEqual(first.query.getAll('group_by[]'), ['api_key_id', 'model', 'service_tier', 'context_window', 'speed', 'inference_geo']);
  assert.equal(first.query.get('bucket_width'), '1d');
});

test('the cost report is grouped by description and workspace, never by key', async () => {
  const api = createFakeApi();
  await clientFor(api).costReport(window);
  assert.deepEqual(api.requests[0].query.getAll('group_by[]'), ['description', 'workspace_id']);
});

test('the window ends at midnight after the last day, so the last day is included', async () => {
  const api = createFakeApi();
  await clientFor(api).costReport(window);
  const q = api.requests[0].query;
  assert.equal(q.get('starting_at'), '2026-10-01T00:00:00Z');
  assert.equal(q.get('ending_at'), '2026-10-04T00:00:00Z');
});

test('the key list is paged with after_id and last_id', async () => {
  const api = createFakeApi({ pageSize: 2 });
  const keys = await clientFor(api).listApiKeys();
  assert.equal(keys.length, 3);
  const calls = api.requests.filter((r) => r.path.endsWith('/api_keys'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].query.get('after_id'), null);
  assert.equal(calls[1].query.get('after_id'), keys[1].id);
});

test('a rate-limited request is retried after the retry-after delay', async () => {
  const api = createFakeApi();
  let calls = 0;
  const waits = [];
  const flaky = async (url, init) => {
    if (++calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
    return api.fetchImpl(url, init);
  };
  const client = createClient({ adminKey: 'test-admin-key', baseUrl: 'https://fake.invalid', fetchImpl: flaky, sleep: async (ms) => { waits.push(ms); } });
  const keys = await client.listApiKeys();
  assert.equal(keys.length, 3);
  assert.deepEqual(waits, [2000]);
});

test('retries stop after maxRetries and the error says what failed', async () => {
  const always503 = async () => new Response('{"error":{"message":"overloaded"}}', { status: 503 });
  const client = createClient({ adminKey: 'test-admin-key', baseUrl: 'https://fake.invalid', fetchImpl: always503, sleep: noSleep, maxRetries: 2 });
  await assert.rejects(client.costReport(window), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 503);
    assert.match(err.message, /cost_report: HTTP 503: overloaded/);
    return true;
  });
});

test('a rejected key gives an ApiError with status 401', async () => {
  const api = createFakeApi();
  const client = createClient({ adminKey: 'wrong-key', baseUrl: 'https://fake.invalid', fetchImpl: api.fetchImpl, sleep: noSleep });
  await assert.rejects(client.costReport(window), (err) => err instanceof ApiError && err.status === 401);
});

test('a key echoed back by the server never reaches the error message', async () => {
  const api = createFakeApi({ echoKeyInErrors: true });
  const client = createClient({ adminKey: 'wrong-SECRET-key', baseUrl: 'https://fake.invalid', fetchImpl: api.fetchImpl, sleep: noSleep });
  await assert.rejects(client.costReport(window), (err) => {
    assert.ok(!err.message.includes('wrong-SECRET-key'), err.message);
    assert.match(err.message, /\[redacted\]/);
    return true;
  });
});

test('a network failure is reported without the key and after retries', async () => {
  let calls = 0;
  const down = async () => { calls++; throw new TypeError('fetch failed for test-admin-key', { cause: { code: 'ECONNREFUSED' } }); };
  const client = createClient({ adminKey: 'test-admin-key', baseUrl: 'https://fake.invalid', fetchImpl: down, sleep: noSleep, maxRetries: 1 });
  await assert.rejects(client.listApiKeys(), (err) => {
    assert.match(err.message, /network error: ECONNREFUSED/);
    assert.ok(!err.message.includes('test-admin-key'));
    return true;
  });
  assert.equal(calls, 2);
});

test('a page that says has_more without a cursor ends instead of looping', async () => {
  const stuck = async () => new Response(JSON.stringify({ data: [{ starting_at: '2026-10-01T00:00:00Z', results: [] }], has_more: true, next_page: null }));
  const client = createClient({ adminKey: 'test-admin-key', baseUrl: 'https://fake.invalid', fetchImpl: stuck, sleep: noSleep });
  const buckets = await client.costReport(window);
  assert.equal(buckets.length, 1);
});

test('a non-JSON response is an error, not a crash', async () => {
  const html = async () => new Response('<html>gateway</html>', { status: 200 });
  const client = createClient({ adminKey: 'test-admin-key', baseUrl: 'https://fake.invalid', fetchImpl: html, sleep: noSleep });
  await assert.rejects(client.costReport(window), /not JSON/);
});

test('nextDay crosses month, year and leap-day boundaries', () => {
  assert.equal(nextDay('2026-10-31'), '2026-11-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  assert.equal(nextDay('2028-02-28'), '2028-02-29');
  assert.equal(nextDay('2026-02-28'), '2026-03-01');
});

test('createClient refuses to run without a key', () => {
  assert.throws(() => createClient({}), /adminKey is required/);
});
