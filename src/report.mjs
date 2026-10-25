// Pure functions: API responses in, a report object out. No I/O, so every path is testable.
//
// The problem this solves: Anthropic's cost report can be grouped by workspace and by line item,
// but not by API key. The usage report can be grouped by API key, but it only has token counts.
// So the cost of a key is worked out here, from the two reports together:
//
//   1. Cost report rows are keyed by (model, service tier, context window, speed, inference geo,
//      token type). Usage rows are expanded into the same cells, one per token type.
//   2. For each cell the real money is split across the API keys in proportion to their tokens.
//      That is the effective unit price Anthropic actually charged, so no price table is needed
//      and every matched cell is handed out in full (keys plus unattributed equal the total).
//   3. Whatever cannot be matched is reported, never dropped: cost lines that are not tokens
//      (code execution, sessions), cost with no matching usage, and usage with no matching cost
//      (the cost report leaves out Priority Tier).

export const TOKEN_TYPES = [
  'uncached_input_tokens',
  'cache_read_input_tokens',
  'cache_creation.ephemeral_5m_input_tokens',
  'cache_creation.ephemeral_1h_input_tokens',
  'output_tokens',
];

const num = (v) => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const str = (v) => (v == null ? '' : String(v));
const day = (bucket) => str(bucket?.starting_at).slice(0, 10);

// The cost report returns amounts as decimal strings in cents ("123.45" is $1.23).
export const usdFromCents = (amount) => num(amount) / 100;

export function flattenCost(buckets) {
  const rows = [];
  for (const b of buckets || []) {
    for (const r of b.results || []) {
      const usd = usdFromCents(r.amount);
      const base = { day: day(b), usd, label: r.description || r.cost_type || 'unlabelled', model: str(r.model) };
      if (r.cost_type === 'tokens' && r.token_type && r.model) {
        rows.push({
          ...base, kind: 'tokens', tokenType: r.token_type,
          tier: str(r.service_tier), ctx: str(r.context_window), speed: str(r.speed), geo: str(r.inference_geo),
        });
      } else if (r.cost_type === 'web_search') {
        rows.push({ ...base, kind: 'web' });
      } else {
        rows.push({ ...base, kind: 'other' });
      }
    }
  }
  return rows;
}

// One cell per (api key, model, tier, ...) and token type, summed over the window.
export function flattenUsage(buckets) {
  const cells = new Map();
  const add = (c) => {
    if (!(c.qty > 0)) return;
    const k = `${c.keyId}|${exactKey(c)}`;
    const e = cells.get(k);
    if (e) e.qty += c.qty; else cells.set(k, { ...c });
  };
  for (const b of buckets || []) {
    for (const r of b.results || []) {
      const dims = {
        keyId: str(r.api_key_id), model: str(r.model), tier: str(r.service_tier),
        ctx: str(r.context_window), speed: str(r.speed), geo: str(r.inference_geo),
      };
      const cc = r.cache_creation || {};
      const qty = {
        'uncached_input_tokens': num(r.uncached_input_tokens),
        'cache_read_input_tokens': num(r.cache_read_input_tokens),
        'cache_creation.ephemeral_5m_input_tokens': num(cc.ephemeral_5m_input_tokens),
        'cache_creation.ephemeral_1h_input_tokens': num(cc.ephemeral_1h_input_tokens),
        'output_tokens': num(r.output_tokens),
      };
      for (const t of TOKEN_TYPES) add({ ...dims, kind: 'tokens', tokenType: t, qty: qty[t] });
      add({ ...dims, kind: 'web', tokenType: 'web_search_requests', qty: num(r.server_tool_use?.web_search_requests) });
    }
  }
  return [...cells.values()];
}

// Strict match first, then a looser one (model and token type only) for whatever is left over.
// The loose pass exists so that a dimension the two reports label differently does not strand money.
function exactKey(x) {
  return x.kind === 'web' ? 'web' : `${x.model}|${x.tier}|${x.ctx}|${x.speed}|${x.geo}|${x.tokenType}`;
}
function looseKey(x) {
  return x.kind === 'web' ? 'web' : `${x.model}|${x.tokenType}`;
}

function allocatePass(costRows, cells, keyFn) {
  const costBy = new Map();
  for (const c of costRows) {
    const k = keyFn(c);
    const e = costBy.get(k) || { usd: 0, rows: [] };
    e.usd += c.usd; e.rows.push(c); costBy.set(k, e);
  }
  const cellBy = new Map();
  for (const c of cells) {
    const k = keyFn(c);
    const e = cellBy.get(k) || { qty: 0, cells: [] };
    e.qty += c.qty; e.cells.push(c); cellBy.set(k, e);
  }
  const allocations = [], leftoverCost = [], leftoverCells = [];
  for (const [k, e] of costBy) {
    const g = cellBy.get(k);
    if (g && g.qty > 0) {
      for (const cell of g.cells) allocations.push({ keyId: cell.keyId, model: cell.model, usd: (e.usd * cell.qty) / g.qty });
      cellBy.delete(k);
    } else {
      leftoverCost.push(...e.rows);
    }
  }
  for (const g of cellBy.values()) leftoverCells.push(...g.cells);
  return { allocations, leftoverCost, leftoverCells };
}

export function allocate(costRows, cells) {
  const allocatable = costRows.filter((r) => r.kind !== 'other');
  const other = costRows.filter((r) => r.kind === 'other');
  const exact = allocatePass(allocatable, cells, exactKey);
  const loose = allocatePass(exact.leftoverCost, exact.leftoverCells, looseKey);
  return {
    allocations: [...exact.allocations, ...loose.allocations],
    exactCount: exact.allocations.length,
    looseCount: loose.allocations.length,
    unmatchedCost: [...loose.leftoverCost, ...other],
    unmatchedCostIsOther: new Set(other),
    unpricedCells: loose.leftoverCells,
  };
}

// keys: the /v1/organizations/api_keys listing (may be empty if the call was not permitted).
export function buildReport({ costBuckets, usageBuckets, keys = [], since, until }) {
  const costRows = flattenCost(costBuckets);
  const cells = flattenUsage(usageBuckets);
  const result = allocate(costRows, cells);

  const keyInfo = new Map(keys.map((k) => [k.id, k]));
  const byKey = new Map();
  const keyRow = (id) => {
    let e = byKey.get(id);
    if (!e) {
      const info = keyInfo.get(id);
      e = {
        id: id || null,
        name: id ? (info?.name || id) : '(no API key: Console or playground)',
        known: !!info,
        status: info?.status || null,
        usd: 0,
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        webSearchRequests: 0,
        unpricedTokens: 0,
      };
      byKey.set(id, e);
    }
    return e;
  };

  for (const c of cells) {
    const e = keyRow(c.keyId);
    if (c.kind === 'web') e.webSearchRequests += c.qty;
    else if (c.tokenType === 'uncached_input_tokens') e.tokens.input += c.qty;
    else if (c.tokenType === 'cache_read_input_tokens') e.tokens.cacheRead += c.qty;
    else if (c.tokenType === 'output_tokens') e.tokens.output += c.qty;
    else e.tokens.cacheWrite += c.qty;
  }
  for (const a of result.allocations) keyRow(a.keyId).usd += a.usd;
  for (const c of result.unpricedCells) if (c.kind === 'tokens') keyRow(c.keyId).unpricedTokens += c.qty;

  const totalUsd = costRows.reduce((s, r) => s + r.usd, 0);
  const allocatedUsd = result.allocations.reduce((s, a) => s + a.usd, 0);

  const group = (rows, labelFn) => {
    const m = new Map();
    for (const r of rows) m.set(labelFn(r), (m.get(labelFn(r)) || 0) + r.usd);
    return [...m.entries()].map(([label, usd]) => ({ label, usd })).sort((a, b) => b.usd - a.usd);
  };

  const unattributed = group(result.unmatchedCost, (r) => (
    result.unmatchedCostIsOther.has(r) ? r.label : `${r.label} (no matching usage)`
  ));

  const unpriced = new Map();
  for (const c of result.unpricedCells) {
    const label = c.kind === 'web' ? 'web search requests' : `${c.model || 'unknown model'} (${c.tier || 'unknown tier'})`;
    unpriced.set(label, (unpriced.get(label) || 0) + c.qty);
  }

  const share = (usd) => (totalUsd > 0 ? usd / totalUsd : 0);
  const days = daysBetween(since, until);

  return {
    window: { since, until, days },
    currency: 'USD',
    totalUsd,
    perDayUsd: totalUsd / Math.max(1, days),
    byKey: [...byKey.values()]
      .map((e) => ({ ...e, share: share(e.usd) }))
      .sort((a, b) => b.usd - a.usd || (tokenSum(b) - tokenSum(a))),
    byModel: group(costRows, (r) => r.model || r.label).map((r) => ({ model: r.label, usd: r.usd, share: share(r.usd) })),
    byDay: group(costRows, (r) => r.day).map((r) => ({ day: r.label, usd: r.usd })).sort((a, b) => (a.day < b.day ? -1 : 1)),
    unattributed: unattributed.map((r) => ({ ...r, share: share(r.usd) })),
    unpriced: [...unpriced.entries()].map(([label, quantity]) => ({ label, quantity })),
    reconciliation: {
      costReportUsd: totalUsd,
      allocatedToKeysUsd: allocatedUsd,
      unattributedUsd: totalUsd - allocatedUsd,
      exactMatches: result.exactCount,
      looseMatches: result.looseCount,
    },
  };
}

const tokenSum = (k) => k.tokens.input + k.tokens.cacheRead + k.tokens.cacheWrite + k.tokens.output;

export function daysBetween(since, until) {
  const ms = Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`);
  return Math.round(ms / 864e5) + 1;
}
