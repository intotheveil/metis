#!/usr/bin/env bash
# PostToolUse (Write|Edit). Auto-formats the written file. Non-blocking.
#
# OPT-IN BY REPO (2026-09-14). This used to run `prettier --write` on every touched file in
# every fleet repo. On a repo that has NEVER been prettier-formatted that rewrites the WHOLE
# file to prettier's DEFAULTS, so a small change lands as a whole-file diff: measured on
# pipepro-wms, a 40-line fix came out as a 13,189-line diff on one 392 KB page. That defeats
# review (CLAUDE.md §6 grades the diff, and the `reviewer` agent reads it), turns every edit
# into an out-of-scope write (§3.5), and makes two branches touching one file conflict across
# all of it. 8 of 14 fleet repos have no prettier config; 497 of pipepro-wms's 500 src files
# are not prettier-clean.
#
# It stayed invisible for weeks because it fails silently in BOTH directions: `npx --no-install`
# exits 0 when the package is absent, and the call is `|| true`. So the hook was a no-op on any
# machine without prettier cached, and indistinguishable from a working one.
#
# So: format only where the repo has ADOPTED prettier — a config file at the repo root. The
# repos that configured it (argus-news, cicada, daedalus-piping, hyperion-epc, tenderforge,
# zeus-dashboard) are unaffected; the rest become the no-op they effectively already were.
# A repo that WANTS formatting adopts it deliberately: add a config pinning its real style,
# add prettier as a devDependency so the version is locked (the hook otherwise resolves
# whatever happens to sit in the machine's npx cache), and reformat once in its own commit.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/_json.sh"
INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | jget '.tool_input.file_path')"
[ -z "$FILE" ] && FILE="$(printf '%s' "$INPUT" | jget '.inputs.file_path')"
[ -z "$FILE" ] && exit 0
[ -f "$FILE" ] || exit 0

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.md) ;;
  *) exit 0 ;;
esac

# Walk up from the file to the repo root (the directory holding .git), then require a prettier
# config there. No config = the repo never adopted prettier = do nothing.
d="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd)" || exit 0
root=""
while [ -n "$d" ] && [ "$d" != "/" ]; do
  if [ -e "$d/.git" ]; then root="$d"; break; fi
  d="$(dirname "$d")"
done
[ -n "$root" ] || exit 0

has_config=""
for c in .prettierrc .prettierrc.json .prettierrc.yml .prettierrc.yaml .prettierrc.json5 \
         .prettierrc.js .prettierrc.cjs .prettierrc.mjs .prettierrc.toml \
         prettier.config.js prettier.config.cjs prettier.config.mjs; do
  [ -f "$root/$c" ] && { has_config=1; break; }
done
# package.json may carry a "prettier" key instead of a separate file.
[ -z "$has_config" ] && [ -f "$root/package.json" ] \
  && grep -q '"prettier"[[:space:]]*:' "$root/package.json" 2>/dev/null && has_config=1
[ -n "$has_config" ] || exit 0

command -v npx >/dev/null 2>&1 && npx --no-install prettier --write "$FILE" >/dev/null 2>&1 || true
exit 0
