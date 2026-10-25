// Thin client for the three Admin API endpoints this tool needs. No dependencies.
// Everything that touches the network goes through createClient(), which takes an
// injectable fetch, so tests never need the live API.

const DEFAULT_BASE = 'https://api.anthropic.com';
const RETRY_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const MAX_PAGES = 1000; // a runaway cursor should end, not loop forever

export class ApiError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
  }
}

export function createClient({
  adminKey,
  baseUrl = DEFAULT_BASE,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxRetries = 3,
  userAgent = 'anthropic-cost-by-key/0.1.0',
} = {}) {
  if (!adminKey) throw new Error('createClient: adminKey is required');
  const base = baseUrl.replace(/\/+$/, '');

  // Never let the key reach an error message, whatever the server or the network echoes back.
  const redact = (s) => String(s).split(adminKey).join('[redacted]');

  function buildUrl(path, params) {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(`${k}[]`, x));
      else u.searchParams.set(k, v);
    }
    return u;
  }

  async function getJson(url, path) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01', 'user-agent': userAgent },
        });
      } catch (err) {
        if (attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
        throw new ApiError(redact(`${path}: network error: ${err?.cause?.code || err?.message || err}`), { path });
      }
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        const wait = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      if (!res.ok) {
        const detail = body?.error?.message || text.slice(0, 200) || res.statusText;
        throw new ApiError(redact(`${path}: HTTP ${res.status}: ${detail}`), { status: res.status, path });
      }
      if (body == null) throw new ApiError(`${path}: response was not JSON`, { status: res.status, path });
      return body;
    }
  }

  // Usage and cost reports: has_more / next_page, sent back as the `page` parameter.
  async function pagedByPageToken(path, params) {
    const out = [];
    let page;
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await getJson(buildUrl(path, { ...params, page }), path);
      out.push(...(body.data || []));
      if (!body.has_more || !body.next_page) return out;
      page = body.next_page;
    }
    throw new ApiError(`${path}: gave up after ${MAX_PAGES} pages`, { path });
  }

  // API key list: has_more / last_id, sent back as `after_id`.
  async function pagedByAfterId(path, params) {
    const out = [];
    let afterId;
    for (let i = 0; i < MAX_PAGES; i++) {
      const body = await getJson(buildUrl(path, { ...params, after_id: afterId }), path);
      out.push(...(body.data || []));
      if (!body.has_more || !body.last_id) return out;
      afterId = body.last_id;
    }
    throw new ApiError(`${path}: gave up after ${MAX_PAGES} pages`, { path });
  }

  // `since` and `until` are YYYY-MM-DD, both inclusive. The API's ending_at is exclusive,
  // so the window ends at midnight UTC after `until`.
  const span = ({ since, until }) => ({
    starting_at: `${since}T00:00:00Z`,
    ending_at: `${nextDay(until)}T00:00:00Z`,
  });

  return {
    listApiKeys: () => pagedByAfterId('/v1/organizations/api_keys', { limit: 1000 }),

    costReport: (window) => pagedByPageToken('/v1/organizations/cost_report', {
      ...span(window), bucket_width: '1d', group_by: ['description', 'workspace_id'], limit: 31,
    }),

    usageReport: (window) => pagedByPageToken('/v1/organizations/usage_report/messages', {
      ...span(window), bucket_width: '1d', limit: 31,
      group_by: ['api_key_id', 'model', 'service_tier', 'context_window', 'speed', 'inference_geo'],
    }),
  };
}

export function nextDay(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
