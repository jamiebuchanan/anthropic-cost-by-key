#!/usr/bin/env bash
# test/run.sh: runs every test file against synthetic API fixtures. No network, no admin key.
# Needs Node 18.17 or newer. Run from anywhere: bash test/run.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then echo "node is required (18.17 or newer)"; exit 1; fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 18 ]; then echo "node 18.17 or newer is required (found $(node -v))"; exit 1; fi

# A real key in the environment must never be picked up by a test run.
unset ANTHROPIC_ADMIN_KEY ANTHROPIC_BASE_URL

out="$(mktemp)"; trap 'rm -f "$out"' EXIT
node --test --test-reporter=tap "$here"/*.test.mjs >"$out" 2>&1
status=$?

grep -E '^\s*(ok|not ok) ' "$out" | grep -vE '^\s+(ok|not ok) [0-9]+ - (Subtest|/)' | sed -E 's/^\s*ok [0-9]+ - /ok    /; s/^\s*not ok [0-9]+ - /FAIL  /; s/ # .*$//'
pass="$(grep -E '^# pass ' "$out" | awk '{print $3}')"
fail="$(grep -E '^# fail ' "$out" | awk '{print $3}')"
echo
if [ "$status" -ne 0 ] || [ "${fail:-1}" != "0" ]; then
  echo "--- failure detail ---"
  # TAP lists passing tests too; print only the blocks that follow a "not ok" line.
  awk '/^ *not ok /{p=1} /^ *ok /{p=0} p' "$out" | head -80
fi
echo "TESTS: ${pass:-0} pass, ${fail:-?} fail"
[ "$status" -eq 0 ] && [ "${fail:-1}" = "0" ]
