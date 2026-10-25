// A stand-in for the Admin API, built from the synthetic fixtures. Used two ways:
// as an injected fetch (unit tests) and behind a local HTTP server (CLI tests).
// Nothing in the test suite talks to the real API.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

export function createFakeApi({ pageSize = 2, adminKey = 'test-admin-key', echoKeyInErrors = false, data } = {}) {
  const keys = data?.keys ?? fixture('api_keys').data;
  const cost = data?.cost ?? fixture('cost_report').data;
  const usage = data?.usage ?? fixture('usage_report').data;
  const requests = [];

  function handle(urlString, headers = {}) {
    const url = new URL(urlString);
    const given = headers['x-api-key'] ?? '';
    requests.push({ path: url.pathname, query: url.searchParams, headers });
    if (given !== adminKey) {
      const message = echoKeyInErrors ? `invalid x-api-key: ${given}` : 'invalid x-api-key';
      return { status: 401, body: { type: 'error', error: { type: 'authentication_error', message } } };
    }
    if (url.pathname === '/v1/organizations/api_keys') {
      const after = url.searchParams.get('after_id');
      const start = after ? keys.findIndex((k) => k.id === after) + 1 : 0;
      const slice = keys.slice(start, start + pageSize);
      return {
        status: 200,
        body: { data: slice, first_id: slice[0]?.id ?? null, last_id: slice.at(-1)?.id ?? null, has_more: start + pageSize < keys.length },
      };
    }
    const source = { '/v1/organizations/cost_report': cost, '/v1/organizations/usage_report/messages': usage }[url.pathname];
    if (!source) return { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'not found' } } };
    const from = url.searchParams.get('starting_at');
    const to = url.searchParams.get('ending_at');
    const inWindow = source.filter((b) => (!from || b.starting_at >= from) && (!to || b.ending_at <= to));
    const page = url.searchParams.get('page');
    const start = page ? Number(page.replace('page_', '')) : 0;
    const slice = inWindow.slice(start, start + pageSize);
    const more = start + pageSize < inWindow.length;
    return { status: 200, body: { data: slice, has_more: more, next_page: more ? `page_${start + pageSize}` : null } };
  }

  const fetchImpl = async (url, init = {}) => {
    const r = handle(String(url), init.headers);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };

  async function listen() {
    const server = createServer((req, res) => {
      const r = handle(`http://127.0.0.1${req.url}`, req.headers);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
  }

  return { handle, fetchImpl, listen, requests, adminKey };
}

export { fixture };
