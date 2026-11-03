# Install anthropic-cost-by-key

You are installing anthropic-cost-by-key for the user: a Node command line tool that shows which API key spent the money, using real figures from Anthropic's Admin API. It is read-only and has no dependencies. Follow the sections below in order. Do not change any file in the repo you clone.

## Prerequisites

Check each one. If one is missing, stop and tell the user what to install.

- Node 18.17 or newer: `node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)' && echo node ok`
- git: `git --version`
- bash: `bash --version`
- An Anthropic organization with an Admin API key. This cannot be checked from here: the Admin API is not available on individual accounts, and a normal workspace API key is rejected. Only the Verify live step needs it.

## Locate config

The tool has no config file. It is a cloned folder you run with `node`. Before you install, check for an existing install:

```bash
command -v anthropic-cost-by-key
ls -d anthropic-cost-by-key 2>/dev/null
```

If either shows something, tell the user and ask whether to reuse it or install fresh. Otherwise clone into the current folder (this creates an `anthropic-cost-by-key` subfolder), or into a folder the user names.

## Install

```bash
git clone https://github.com/jamiebuchanan/anthropic-cost-by-key.git
cd anthropic-cost-by-key
```

Optional, only if the user wants the command on their path: `npm install -g .` from the cloned folder. This writes to the global npm folder, so ask first. Without it, run the tool as `node bin/anthropic-cost-by-key.mjs` from the clone.

## Credentials

One environment variable: `ANTHROPIC_ADMIN_KEY`, an Admin API key from an organization (Claude Console, Settings, Admin keys). The tool reads the key from that variable and nowhere else. Optionally `ANTHROPIC_BASE_URL`, which defaults to `https://api.anthropic.com` and normally should be left unset.

The user sets the key in their own terminal so it stays out of shell history:

```bash
read -rs ANTHROPIC_ADMIN_KEY && export ANTHROPIC_ADMIN_KEY      # paste, press enter
```

Do not ask the user to paste the key to you, and do not write it into any file.

## Validate

This needs no key. It runs the tool's tests against a fake API from inside the clone and prints one line.

```bash
bash test/run.sh >/dev/null && echo "ok: anthropic-cost-by-key tests pass against a fake API"
```

It should print `ok: anthropic-cost-by-key tests pass against a fake API`. Any other output means the install failed: run `bash test/run.sh` on its own and report the failure to the user. A cheaper check is `node bin/anthropic-cost-by-key.mjs --help`, which prints the usage text.

## Verify live

This step needs the user's own Admin API key and organization, so do not run it yourself unless the user has set `ANTHROPIC_ADMIN_KEY` in your environment and asks you to. From the clone, the user runs:

```bash
node bin/anthropic-cost-by-key.mjs --days 7
```

A working run prints cost by API key, by model and by day for the last 7 days, then a reconciliation whose total matches the cost report. Exit codes: `0` success, `1` the API refused or failed, `2` bad arguments or no key. A refusal usually means the key is a workspace key, not an Admin key, or the account is not an organization.

## Safety rules

- The tool is read-only: it makes GET requests to three Anthropic endpoints and nothing else. Do not add other calls.
- Never print, log, echo or store the Admin key, and never put it in a command line, a file or a commit.
- Do not run the Validate step with a real key set: the tests unset it, but keep it out of the environment anyway.
- Ask before `npm install -g .` or before replacing an existing install.
- The tool shows attribution, not an invoice, and only for API usage. Claude Pro, Max and Team subscription use is not covered.
