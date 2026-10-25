# anthropic-cost-by-key

Which API key spent the money? One command, real figures from Anthropic's own Admin API, no estimates from a price list.

```
$ export ANTHROPIC_ADMIN_KEY=sk-ant-admin01-...
$ node bin/anthropic-cost-by-key.mjs --days 7
```

I wrote this after an organization's API credit ran out and nobody could say quickly which key had spent it. The numbers exist, but they are split across two reports: the **cost report** has the real dollars but cannot be grouped by API key, and the **usage report** can be grouped by API key but only has token counts. This tool joins them, so each key is charged its share of what Anthropic actually billed.

Zero dependencies. Node 18.17 or newer. Read-only.

## What you get

- **Cost by API key**, with token counts (input, cache read, cache write, output) next to each key's cost and share.
- **Cost by model** and **cost by day**, straight from the cost report.
- **Anything that cannot be pinned on a key**, listed rather than hidden: code execution and other non-token line items, cost with no matching usage.
- **Usage that has no cost line** (Priority Tier is billed separately and is not in the cost report), flagged instead of guessed.
- **A reconciliation**: keys plus unattributed always add up to the cost report total.
- `--json` for the same report as data.

## Setup

You need an Admin API credential. A normal workspace API key is rejected by these endpoints, and the Admin API is not available on individual accounts, only on organizations. See Anthropic's [Admin API](https://platform.claude.com/docs/en/manage-claude/admin-api) docs for how to create one (Claude Console, Settings, Admin keys).

The key is read from the `ANTHROPIC_ADMIN_KEY` environment variable and nowhere else. Keep it out of your shell history:

```bash
read -rs ANTHROPIC_ADMIN_KEY && export ANTHROPIC_ADMIN_KEY      # paste, press enter
# or from a secret manager, for example the 1Password CLI:
export ANTHROPIC_ADMIN_KEY="$(op read 'op://Private/Anthropic admin key/credential')"
```

Then:

```bash
git clone https://github.com/jamiebuchanan/anthropic-cost-by-key.git
cd anthropic-cost-by-key
bash test/run.sh                          # optional: every test should pass
node bin/anthropic-cost-by-key.mjs        # last 30 days
```

To get a command on your path: `npm install -g .` from the cloned folder.

## Usage

```
anthropic-cost-by-key [--days N] [--json]
anthropic-cost-by-key --since YYYY-MM-DD [--until YYYY-MM-DD] [--json]
```

| Option | Meaning |
|---|---|
| `--days N` | The last N days including today. Default 30. |
| `--since DATE` | First day of the window (UTC). |
| `--until DATE` | Last day of the window (UTC), inclusive. Default today. |
| `--json` | Print the report as JSON and nothing else. |

| Environment variable | Meaning |
|---|---|
| `ANTHROPIC_ADMIN_KEY` | Required. An Admin API credential. |
| `ANTHROPIC_BASE_URL` | Optional. Defaults to `https://api.anthropic.com`. |

Exit codes: `0` success, `1` the API refused or failed, `2` bad arguments or no key.

## Example output

The numbers below are invented. They come from the synthetic fixtures the tests use (see [`examples/sample-output.txt`](examples/sample-output.txt)).

```
Anthropic cost by API key, 2026-10-01 to 2026-10-03 (3 days, USD)

=== COST BY API KEY ===

  key                                  input tok  cache read  cache write  output tok    cost  share
  -----------------------------------  ---------  ----------  -----------  ----------  ------  -----
  web-backend                          3,550,000   5,000,000      200,000     655,000  $14.50  46.6%
  nightly-batch                        4,000,000           0            0     500,000   $9.75  31.4%
  ci-evals [archived]                  1,000,000           0      500,000     200,000   $3.00   9.6%
  apikey_01FIXTURE000000000000009        200,000           0            0      20,000   $0.90   2.9%
  (no API key: Console or playground)    100,000           0            0      10,000   $0.45   1.4%

  Cost per key is each key's token share of the real cost lines, not a list price estimate.

=== COST BY MODEL ===

  model / line item       cost  share
  --------------------  ------  -----
  claude-sonnet-4-5     $20.10  64.6%
  claude-haiku-4-5       $7.50  24.1%
  Code Execution Usage   $2.50   8.0%
  Web Search Usage       $1.00   3.2%

=== COST BY DAY ===

  day (UTC)     cost
  ----------  ------
  2026-10-01  $18.45
  2026-10-02   $8.50
  2026-10-03   $4.15

=== NOT ATTRIBUTABLE TO A KEY ===

  line item              cost  share
  --------------------  -----  -----
  Code Execution Usage  $2.50   8.0%

=== USAGE WITH NO COST LINE ===

  These are in the usage report but not the cost report (Priority Tier is billed
  separately). They are counted in the token columns above, not in any cost.

  claude-sonnet-4-5 (priority): 55,000

=== RECONCILIATION ===

  cost report total          $31.10
  attributed to API keys     $28.60
  not attributable           $2.50
  matched exactly / loosely  16 / 0 cells

TOTAL over 3 days: $31.10 ($10.37 per day)
```

Key names come from the organization's API key list. A key that has since been deleted shows by its id, and usage with no key at all (the Console playground) gets its own row.

## How the cost per key is worked out

The cost report returns one line per model, service tier, token type and so on, with the real amount billed. The usage report returns, for each API key, how many tokens of each type it used in the same cells. For every cell, the tool splits the real cost across the keys in proportion to their tokens. That is the price Anthropic actually charged for that cell (batch discounts, cache pricing, long-context rates and all), so there is no price table to keep up to date. Every priced cell is handed out in full, so the keys plus whatever cannot be pinned on a key add up to the cost report total.

Web search is split the same way, by number of requests. Cost lines that are not tokens, such as code execution, have no per-key data in the usage report, so they are listed as not attributable.

If a cell does not match exactly (the two reports label a dimension differently), a second pass matches what is left on model and token type alone. The reconciliation shows how many cells needed that.

## Limits

- **It is attribution, not an invoice.** Within one price cell every token costs the same, so splitting by token share is exact for that cell. But the cost report has no per-key data, so a cell that mixes keys is divided, not measured.
- **Admin API credentials only.** Workspace API keys are rejected. Claude Enterprise (claude.ai) organizations have a different Analytics API and are not covered. Claude Platform on AWS does not offer these endpoints, and Claude Models on Google Cloud offers only the usage one (with Google Cloud credentials), so the tool cannot produce a report there; check Anthropic's [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) page.
- **Priority Tier** usage has no cost line in the cost report, so it shows in the token columns and in the "no cost line" list, never in a cost.
- **Freshness.** Anthropic says data usually appears within about five minutes. Today's figures can be partial.
- **Subscriptions are not API usage.** Work done on a Claude Pro, Max or Team subscription (the apps, or Claude Code signed in with an account) is not API usage, so it is not what these reports cover.
- Prices and report shapes are Anthropic's to change. The tool reads fields by name and treats missing ones as empty, but if a report changes shape, the test fixtures are the place to start.

## Tests

```bash
bash test/run.sh
```

The suite runs the report logic, the API client (pagination, retries, error handling, key redaction) and the command line end to end, against synthetic fixtures in `test/fixtures` shaped like the documented API responses. It never calls the live API and ignores any `ANTHROPIC_ADMIN_KEY` in your shell. It has not yet been run against a live organization's reports, so if the reconciliation shows many loose matches or a gap you cannot explain, please open an issue.

## Security notes

- The key is sent only as the `x-api-key` header to the API host and is never printed. If a server error ever echoes it back, it is replaced with `[redacted]` before the message is shown.
- Read-only: the tool makes GET requests to three endpoints (`api_keys`, `cost_report`, `usage_report/messages`) and nothing else.

## Credits

Built by Jamie Buchanan, written with Claude Code. All data comes from Anthropic's [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api); the response shapes in the tests follow its published reference.

This is an independent project. It is not affiliated with or endorsed by Anthropic.

## Licence

MIT. See [LICENSE](LICENSE).
