// Plain-text rendering of a report object. No colour codes, so output pastes cleanly anywhere.

const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => Math.round(n).toLocaleString('en-US');
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function table(title, rows, cols, note) {
  const out = ['', `=== ${title} ===`, ''];
  if (!rows.length) { out.push('  (nothing in this window)'); return out; }
  const cells = rows.map((r) => cols.map((c) => String(c.f(r))));
  const widths = cols.map((c, i) => Math.max(c.h.length, ...cells.map((row) => row[i].length)));
  const pad = (s, i) => (cols[i].right ? s.padStart(widths[i]) : s.padEnd(widths[i]));
  out.push('  ' + cols.map((c, i) => pad(c.h, i)).join('  '));
  out.push('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cells) out.push('  ' + row.map((s, i) => pad(s, i)).join('  '));
  if (note) out.push('', `  ${note}`);
  return out;
}

export function renderText(r) {
  const lines = [`Anthropic cost by API key, ${r.window.since} to ${r.window.until} (${r.window.days} days, ${r.currency})`];

  lines.push(...table('COST BY API KEY', r.byKey, [
    { h: 'key', f: (k) => k.name + (k.status && k.status !== 'active' ? ` [${k.status}]` : '') },
    { h: 'input tok', f: (k) => int(k.tokens.input), right: true },
    { h: 'cache read', f: (k) => int(k.tokens.cacheRead), right: true },
    { h: 'cache write', f: (k) => int(k.tokens.cacheWrite), right: true },
    { h: 'output tok', f: (k) => int(k.tokens.output), right: true },
    { h: 'cost', f: (k) => usd(k.usd), right: true },
    { h: 'share', f: (k) => pct(k.share), right: true },
  ], 'Cost per key is each key\'s token share of the real cost lines, not a list price estimate.'));

  lines.push(...table('COST BY MODEL', r.byModel, [
    { h: 'model / line item', f: (m) => m.model },
    { h: 'cost', f: (m) => usd(m.usd), right: true },
    { h: 'share', f: (m) => pct(m.share), right: true },
  ]));

  lines.push(...table('COST BY DAY', r.byDay, [
    { h: 'day (UTC)', f: (d) => d.day },
    { h: 'cost', f: (d) => usd(d.usd), right: true },
  ]));

  if (r.unattributed.length) {
    lines.push(...table('NOT ATTRIBUTABLE TO A KEY', r.unattributed, [
      { h: 'line item', f: (u) => u.label },
      { h: 'cost', f: (u) => usd(u.usd), right: true },
      { h: 'share', f: (u) => pct(u.share), right: true },
    ]));
  }

  if (r.unpriced.length) {
    lines.push('', '=== USAGE WITH NO COST LINE ===', '',
      '  These are in the usage report but not the cost report (Priority Tier is billed',
      '  separately). They are counted in the token columns above, not in any cost.', '');
    for (const u of r.unpriced) lines.push(`  ${u.label}: ${int(u.quantity)}`);
  }

  const rec = r.reconciliation;
  lines.push('', '=== RECONCILIATION ===', '',
    `  cost report total          ${usd(rec.costReportUsd)}`,
    `  attributed to API keys     ${usd(rec.allocatedToKeysUsd)}`,
    `  not attributable           ${usd(rec.unattributedUsd)}`,
    `  matched exactly / loosely  ${rec.exactMatches} / ${rec.looseMatches} cells`,
    '',
    `TOTAL over ${r.window.days} days: ${usd(r.totalUsd)} (${usd(r.perDayUsd)} per day)`, '');
  return lines.join('\n');
}
