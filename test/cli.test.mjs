import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parseArgs, resolveWindow } from '../src/cli.mjs';
import { createFakeApi } from './fake-api.mjs';

const bin = new URL('../bin/anthropic-cost-by-key.mjs', import.meta.url).pathname;

function run(args, env) {
  return new Promise((resolve) => {
    // A clean environment: nothing from the developer's shell can point the CLI at a real key.
    const child = spawn(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// ---- argument parsing and window maths ----

test('defaults to the last 30 days', () => {
  assert.deepEqual(parseArgs([]), { days: 30 });
});

test('parses --days, --since, --until and --json', () => {
  assert.equal(parseArgs(['--days', '7']).days, 7);
  const o = parseArgs(['--since', '2026-09-01', '--until', '2026-09-30', '--json']);
  assert.deepEqual([o.since, o.until, o.json], ['2026-09-01', '2026-09-30', true]);
});

test('rejects bad input with a clear message', () => {
  assert.throws(() => parseArgs(['--days', '0']), /whole number/);
  assert.throws(() => parseArgs(['--days', 'abc']), /whole number/);
  assert.throws(() => parseArgs(['--since', '2026-13-01']), /date like/);
  assert.throws(() => parseArgs(['--since', '2026-02-30']), /date like/);
  assert.throws(() => parseArgs(['--until']), /needs a value/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  assert.throws(() => parseArgs(['--days', '5', '--since', '2026-09-01']), /not both/);
});

test('--days N means the last N days including today', () => {
  const now = new Date('2026-10-23T15:00:00Z');
  assert.deepEqual(resolveWindow({ days: 7 }, now), { since: '2026-10-17', until: '2026-10-23' });
  assert.deepEqual(resolveWindow({ days: 1 }, now), { since: '2026-10-23', until: '2026-10-23' });
});

test('--since without --until runs to today, and an inverted window is refused', () => {
  const now = new Date('2026-10-23T15:00:00Z');
  assert.deepEqual(resolveWindow({ since: '2026-10-01', days: 30 }, now), { since: '2026-10-01', until: '2026-10-23' });
  assert.throws(() => resolveWindow({ since: '2026-10-05', until: '2026-10-01', days: 30 }, now), /after/);
});

// ---- the whole CLI against a local stand-in for the API ----

let api, server;
before(async () => { api = createFakeApi(); server = await api.listen(); });
after(async () => { await server.close(); });

const good = () => ({ ANTHROPIC_ADMIN_KEY: 'test-admin-key', ANTHROPIC_BASE_URL: server.url });
const win = ['--since', '2026-10-01', '--until', '2026-10-03'];

test('prints the cost by key table and a reconciliation', async () => {
  const r = await run(win, good());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /=== COST BY API KEY ===/);
  assert.match(r.stdout, /web-backend\s.*\$14\.50\s+46\.6%/);
  assert.match(r.stdout, /nightly-batch\s.*\$9\.75/);
  assert.match(r.stdout, /ci-evals \[archived\]\s.*\$3\.00/);
  assert.match(r.stdout, /Code Execution Usage\s+\$2\.50/);
  assert.match(r.stdout, /claude-sonnet-4-5 \(priority\): 55,000/);
  assert.match(r.stdout, /TOTAL over 3 days: \$31\.10 \(\$10\.37 per day\)/);
  assert.equal(r.stderr, '');
});

test('--json prints only JSON', async () => {
  const r = await run([...win, '--json'], good());
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.byKey[0].name, 'web-backend');
  assert.equal(Math.round(report.totalUsd * 100), 3110);
});

test('with no admin key it explains how to get one and makes no request', async () => {
  const before = api.requests.length;
  const r = await run(win, { ANTHROPIC_BASE_URL: server.url });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ANTHROPIC_ADMIN_KEY is not set/);
  assert.equal(r.stdout, '');
  assert.equal(api.requests.length, before);
});

test('a rejected key exits 1 with a hint, prints nothing on stdout, and never shows the key', async () => {
  const echo = createFakeApi({ echoKeyInErrors: true });
  const s = await echo.listen();
  try {
    const r = await run(win, { ANTHROPIC_ADMIN_KEY: 'workspace-key-SECRET', ANTHROPIC_BASE_URL: s.url });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /Admin API credential/);
    assert.ok(!r.stderr.includes('workspace-key-SECRET'), r.stderr);
  } finally { await s.close(); }
});

test('bad arguments exit 2 without touching the API', async () => {
  const before = api.requests.length;
  const r = await run(['--days', 'nope'], good());
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--days must be/);
  assert.equal(api.requests.length, before);
});

test('--help and --version work without a key', async () => {
  const h = await run(['--help'], {});
  assert.equal(h.code, 0);
  assert.match(h.stdout, /ANTHROPIC_ADMIN_KEY/);
  const v = await run(['--version'], {});
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
});

test('if the key list is not permitted the report still runs, with keys shown by id', async () => {
  const noKeys = createFakeApi();
  const original = noKeys.handle;
  const s = await (async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((req, res) => {
      const r = req.url.includes('/api_keys')
        ? { status: 403, body: { error: { message: 'not allowed' } } }
        : original(`http://127.0.0.1${req.url}`, req.headers);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((ok) => srv.close(ok)) };
  })();
  try {
    const r = await run(win, { ANTHROPIC_ADMIN_KEY: 'test-admin-key', ANTHROPIC_BASE_URL: s.url });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /could not list API keys/);
    assert.match(r.stdout, /apikey_01FIXTURE000000000000001/);
  } finally { await s.close(); }
});
