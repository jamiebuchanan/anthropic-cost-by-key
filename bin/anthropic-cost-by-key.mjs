#!/usr/bin/env node
import { createClient, ApiError } from '../src/api.mjs';
import { buildReport } from '../src/report.mjs';
import { renderText } from '../src/format.mjs';
import { parseArgs, resolveWindow, HELP, VERSION } from '../src/cli.mjs';

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) {
    console.error(`${err.message}\n\nRun with --help for usage.`);
    return 2;
  }
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.version) { console.log(VERSION); return 0; }

  const adminKey = (process.env.ANTHROPIC_ADMIN_KEY || '').trim();
  if (!adminKey) {
    console.error(
      'ANTHROPIC_ADMIN_KEY is not set.\n\n' +
      'This tool needs an Admin API credential. A normal workspace API key is rejected.\n' +
      'Create one in the Claude Console under Settings > Admin keys, then:\n\n' +
      '  export ANTHROPIC_ADMIN_KEY=sk-ant-admin01-...\n');
    return 2;
  }

  let window;
  try { window = resolveWindow(opts); } catch (err) {
    console.error(err.message);
    return 2;
  }
  const client = createClient({ adminKey, baseUrl: process.env.ANTHROPIC_BASE_URL || undefined });

  let keys = [];
  try { keys = await client.listApiKeys(); } catch (err) {
    console.error(`Warning: could not list API keys (${err.message}). Keys will be shown by id.`);
  }

  let costBuckets, usageBuckets;
  try {
    [costBuckets, usageBuckets] = await Promise.all([client.costReport(window), client.usageReport(window)]);
  } catch (err) {
    console.error(err instanceof ApiError ? err.message : `Unexpected error: ${err.message}`);
    if (err.status === 401 || err.status === 403) {
      console.error('The credential was rejected. It must be an Admin API credential, not a workspace API key.');
    }
    return 1;
  }

  const report = buildReport({ costBuckets, usageBuckets, keys, ...window });
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderText(report));
  return 0;
}

process.exitCode = await main();
