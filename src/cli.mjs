// Argument parsing and date-window logic, kept out of the bin file so tests can reach it.

export const VERSION = '0.1.0';

export const HELP = `anthropic-cost-by-key ${VERSION}

Cost per API key for an Anthropic organization, from the Admin API usage and cost reports.

Usage:
  anthropic-cost-by-key [--days N] [--json]
  anthropic-cost-by-key --since YYYY-MM-DD [--until YYYY-MM-DD] [--json]

Options:
  --days N          the last N days including today (default 30)
  --since DATE      first day of the window, UTC
  --until DATE      last day of the window, UTC, inclusive (default today)
  --json            print the report as JSON instead of tables
  --help, --version

Environment:
  ANTHROPIC_ADMIN_KEY   required, an Admin API credential (a workspace API key does not work)
  ANTHROPIC_BASE_URL    optional, default https://api.anthropic.com

Read-only. The key is sent to the API as a header and is never printed.`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => {
  if (!DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

export function parseArgs(argv) {
  const opts = { days: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--version') opts.version = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--days') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > 366) throw new Error('--days must be a whole number from 1 to 366');
      opts.days = n; opts.daysGiven = true;
    } else if (a === '--since') {
      opts.since = value();
      if (!validDate(opts.since)) throw new Error('--since must be a date like 2026-09-01');
    } else if (a === '--until') {
      opts.until = value();
      if (!validDate(opts.until)) throw new Error('--until must be a date like 2026-09-30');
    } else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.since && opts.daysGiven) throw new Error('Use --days or --since, not both');
  return opts;
}

export function resolveWindow(opts, now = new Date()) {
  const until = opts.until || now.toISOString().slice(0, 10);
  let since = opts.since;
  if (!since) {
    const d = new Date(`${until}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (opts.days - 1));
    since = d.toISOString().slice(0, 10);
  }
  if (since > until) throw new Error('--since is after --until');
  return { since, until };
}
