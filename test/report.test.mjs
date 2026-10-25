import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, flattenCost, usdFromCents } from '../src/report.mjs';
import { fixture } from './fake-api.mjs';

const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-6, `${msg || 'value'}: expected ${expected}, got ${actual}`);
const window = { since: '2026-10-01', until: '2026-10-03' };
const fixtureReport = () => buildReport({
  costBuckets: fixture('cost_report').data,
  usageBuckets: fixture('usage_report').data,
  keys: fixture('api_keys').data,
  ...window,
});
const byName = (r, name) => r.byKey.find((k) => k.name === name);

test('cost amounts are cents in decimal strings, not dollars', () => {
  near(usdFromCents('123.45'), 1.2345);
  near(usdFromCents('123.78912'), 1.2378912);
  assert.equal(usdFromCents(null), 0);
  assert.equal(usdFromCents('not a number'), 0);
});

test('fixture total equals the sum of the cost report', () => {
  const r = fixtureReport();
  near(r.totalUsd, 31.1, 'total');
  near(r.perDayUsd, 31.1 / 3, 'per day');
  assert.equal(r.window.days, 3);
});

test('each key is charged its share of the real cost lines', () => {
  const r = fixtureReport();
  near(byName(r, 'web-backend').usd, 14.5, 'web-backend');   // sonnet + haiku tokens, cache reads and writes, plus web search
  near(byName(r, 'nightly-batch').usd, 9.75, 'nightly-batch'); // batch pricing, cost rows split across workspaces
  near(byName(r, 'ci-evals').usd, 3.0, 'ci-evals');            // includes a 1-hour cache write
  near(r.byKey.find((k) => k.id === null).usd, 0.45, 'no key');
});

test('keys sort by cost, biggest first', () => {
  const r = fixtureReport();
  assert.deepEqual(r.byKey.map((k) => k.name), [
    'web-backend', 'nightly-batch', 'ci-evals',
    'apikey_01FIXTURE000000000000009', '(no API key: Console or playground)',
  ]);
});

test('a key missing from the key listing is shown by id and flagged unknown', () => {
  const r = fixtureReport();
  const k = r.byKey.find((x) => x.id === 'apikey_01FIXTURE000000000000009');
  assert.equal(k.known, false);
  assert.equal(k.name, 'apikey_01FIXTURE000000000000009');
  near(k.usd, 0.9, 'unknown key cost');
});

test('usage with no key id is its own row (Console or playground)', () => {
  const r = fixtureReport();
  const k = r.byKey.find((x) => x.id === null);
  assert.match(k.name, /no API key/);
  assert.equal(k.known, false);
});

test('without a key listing, keys fall back to their ids', () => {
  const r = buildReport({ costBuckets: fixture('cost_report').data, usageBuckets: fixture('usage_report').data, keys: [], ...window });
  assert.ok(r.byKey.some((k) => k.name === 'apikey_01FIXTURE000000000000001'));
  near(r.byKey.find((k) => k.id === 'apikey_01FIXTURE000000000000001').usd, 14.5);
});

test('token columns sum every token type, cache writes combine 5m and 1h', () => {
  const r = fixtureReport();
  const web = byName(r, 'web-backend');
  assert.equal(web.tokens.input, 3_550_000);   // 1M + 2M + 0.5M + 50k priority
  assert.equal(web.tokens.cacheRead, 5_000_000);
  assert.equal(web.tokens.cacheWrite, 200_000);
  assert.equal(web.tokens.output, 655_000);
  assert.equal(web.webSearchRequests, 100);
  assert.equal(byName(r, 'ci-evals').tokens.cacheWrite, 500_000);
});

test('Priority Tier usage has no cost line, so it is flagged rather than guessed', () => {
  const r = fixtureReport();
  assert.equal(byName(r, 'web-backend').unpricedTokens, 55_000);
  assert.deepEqual(r.unpriced, [{ label: 'claude-sonnet-4-5 (priority)', quantity: 55_000 }]);
});

test('cost lines that are not tokens stay unattributed', () => {
  const r = fixtureReport();
  assert.equal(r.unattributed.length, 1);
  assert.equal(r.unattributed[0].label, 'Code Execution Usage');
  near(r.unattributed[0].usd, 2.5);
});

test('keys plus unattributed always add up to the cost report', () => {
  const r = fixtureReport();
  const keys = r.byKey.reduce((s, k) => s + k.usd, 0);
  const rest = r.unattributed.reduce((s, u) => s + u.usd, 0);
  near(keys, r.reconciliation.allocatedToKeysUsd, 'keys vs reconciliation');
  near(keys + rest, r.totalUsd, 'keys + unattributed vs total');
  near(r.reconciliation.unattributedUsd, 2.5);
  assert.equal(r.reconciliation.looseMatches, 0);
  assert.ok(r.reconciliation.exactMatches > 0);
});

test('by model and by day come straight from the cost report', () => {
  const r = fixtureReport();
  const model = (name) => r.byModel.find((m) => m.model === name).usd;
  near(model('claude-sonnet-4-5'), 20.1, 'sonnet, standard plus batch');
  near(model('claude-haiku-4-5'), 7.5, 'haiku');
  near(model('Web Search Usage'), 1.0, 'web search line');
  near(model('Code Execution Usage'), 2.5, 'code execution line');
  assert.deepEqual(r.byDay.map((d) => d.day), ['2026-10-01', '2026-10-02', '2026-10-03']);
  near(r.byDay[0].usd, 18.45, 'day 1');
  near(r.byDay[1].usd, 8.5, 'day 2');
  near(r.byDay[2].usd, 4.15, 'day 3');
});

test('a label the two reports spell differently is rescued by the loose pass', () => {
  const cost = [{
    starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-02T00:00:00Z',
    results: [{ amount: '500', cost_type: 'tokens', description: 'x', model: 'm1', service_tier: 'standard', context_window: '0-200k', speed: 'standard', inference_geo: 'us', token_type: 'output_tokens' }],
  }];
  const usage = [{
    starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-02T00:00:00Z',
    results: [{ api_key_id: 'k1', model: 'm1', service_tier: 'standard', context_window: '0-200k', speed: 'standard', inference_geo: 'global', output_tokens: 1000 }],
  }];
  const r = buildReport({ costBuckets: cost, usageBuckets: usage, keys: [{ id: 'k1', name: 'only-key' }], since: '2026-10-01', until: '2026-10-01' });
  near(byName(r, 'only-key').usd, 5);
  assert.equal(r.reconciliation.exactMatches, 0);
  assert.equal(r.reconciliation.looseMatches, 1);
  assert.equal(r.unattributed.length, 0);
});

test('token cost with no matching usage is reported, not dropped', () => {
  const cost = [{
    starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-02T00:00:00Z',
    results: [{ amount: '300', cost_type: 'tokens', description: 'Orphan Usage - Output Tokens', model: 'm9', service_tier: 'standard', token_type: 'output_tokens' }],
  }];
  const r = buildReport({ costBuckets: cost, usageBuckets: [], keys: [], since: '2026-10-01', until: '2026-10-01' });
  near(r.totalUsd, 3);
  assert.equal(r.unattributed[0].label, 'Orphan Usage - Output Tokens (no matching usage)');
  near(r.unattributed[0].usd, 3);
});

test('one cost cell is split across keys in proportion to tokens', () => {
  const cost = [{
    starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-02T00:00:00Z',
    results: [{ amount: '1000', cost_type: 'tokens', description: 'd', model: 'm', service_tier: 'standard', context_window: '0-200k', speed: 'standard', inference_geo: 'global', token_type: 'output_tokens' }],
  }];
  const row = (k, n) => ({ api_key_id: k, model: 'm', service_tier: 'standard', context_window: '0-200k', speed: 'standard', inference_geo: 'global', output_tokens: n });
  const usage = [{ starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-02T00:00:00Z', results: [row('a', 750), row('b', 250)] }];
  const r = buildReport({ costBuckets: cost, usageBuckets: usage, keys: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }], since: '2026-10-01', until: '2026-10-01' });
  near(byName(r, 'a').usd, 7.5);
  near(byName(r, 'b').usd, 2.5);
});

test('an empty window gives an empty report with no NaN', () => {
  const r = buildReport({ costBuckets: [], usageBuckets: [], keys: [], since: '2026-10-01', until: '2026-10-07' });
  assert.equal(r.totalUsd, 0);
  assert.equal(r.perDayUsd, 0);
  assert.deepEqual(r.byKey, []);
  assert.deepEqual(r.byModel, []);
  assert.deepEqual(r.unattributed, []);
});

test('flattenCost tolerates rows with missing fields', () => {
  const rows = flattenCost([{ starting_at: '2026-10-01T00:00:00Z', results: [{}, { amount: 'abc', cost_type: 'tokens' }] }]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.usd === 0 && x.kind === 'other'));
});
