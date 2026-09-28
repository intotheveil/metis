#!/usr/bin/env bash
# PreToolUse guard. Reads the hook JSON on stdin. Exit 2 blocks the tool call
# and feeds the stderr message back to the agent as actionable feedback.
# Fires recursively for subagent tool calls too, so a subagent cannot bypass it.
#
# UNION of the three variants that had drifted across the fleet (audited 2026-09-11):
#   base                     8 repos
#   + client-data scan       cicada, daedalus-piping, hyperion-epc, hera
#   + committed-template allowance   zeus-hq only
# None of those were rot — each was a lesson learned in one repo that never reached the
# other twelve, because the crew half of the kit was distributed as prose while only the
# brain half had a named source file. This file is that named source.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# FAIL CLOSED. If the guard cannot load its JSON helper it cannot parse the tool call, and a
# guard that cannot inspect a command must REFUSE it, never wave it through. Proven necessary:
# with _json.sh absent, `source` under `set -e` exits 1 — and exit 1 is NON-blocking in the
# hook contract, so every destructive command sailed past a guard that had already crashed.
# Exit 2 is the only blocking code; anything else is a silent allow.
if [ ! -r "$DIR/_json.sh" ]; then
  echo "BLOCKED by guard: guard is broken — $DIR/_json.sh is missing or unreadable." >&2
  echo "Refusing the tool call rather than allowing it unchecked. Restore the kit hooks." >&2
  exit 2
fi
# shellcheck source=/dev/null
source "$DIR/_json.sh" || { echo "BLOCKED by guard: _json.sh failed to load." >&2; exit 2; }
if ! type jget >/dev/null 2>&1; then
  echo "BLOCKED by guard: _json.sh loaded but jget is undefined." >&2; exit 2
fi

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT"  | jget '.tool_input.command')"
FILE="$(printf '%s' "$INPUT" | jget '.tool_input.file_path')"

block() { echo "BLOCKED by guard: $1" >&2; exit 2; }

case "$FILE" in
  # Secret-free, COMMITTED templates are allowed (tracked deliverables). This branch is
  # matched FIRST, so they never reach the block pattern below. Real env files still block.
  *.env.example|*.env.sample|*.env.template)
    : ;;
  *.env|*.env.*|*/secrets/*|*service-role*|*serviceRole*|*.pem|*.key)
    block "secret/credential file access is not allowed ($FILE). Read config from process env." ;;
esac

if [ -n "$CMD" ]; then
  if echo "$CMD" | grep -Eq 'rm[[:space:]]+-rf[[:space:]]+/|rm[[:space:]]+-rf[[:space:]]+~|rm[[:space:]]+-rf[[:space:]]+\.($|[[:space:]])'; then
    block "recursive force-delete of a root/home/cwd path. If intended, a human must run it."
  fi
  # Destructive SQL. Requires a real statement shape — VERB + object + an identifier — so that
  # PROSE describing the rule does not trip it. (It did: writing the §7 checkpoint text, which
  # lists "dropping a table" as a human-gated operation, was blocked by the looser pattern.)
  if echo "$CMD" | grep -Eiq '(^|[;&|"'"'"'[:space:]])drop[[:space:]]+(table|database|schema)[[:space:]]+[a-zA-Z_"`]'; then
    block "destructive SQL (DROP). Human-gated - log it in BUILD_LOG.md and stop."
  fi
  if echo "$CMD" | grep -Eiq '(^|[;&|"'"'"'[:space:]])truncate[[:space:]]+table[[:space:]]+[a-zA-Z_"`]'; then
    block "destructive SQL (TRUNCATE). Human-gated - log it in BUILD_LOG.md and stop."
  fi
  if echo "$CMD" | grep -Eq 'git[[:space:]]+push[[:space:]]+.*--force|git[[:space:]]+push[[:space:]]+-f'; then
    block "force-push. Not permitted for the crew - a human must decide."
  fi
  if echo "$CMD" | grep -Eq 'git[[:space:]]+reset[[:space:]]+--hard|git[[:space:]]+clean[[:space:]]+-[a-z]*f'; then
    block "hard reset / forced clean discards uncommitted work. Human-gated."
  fi
  # Reading a .env through the shell. `[^|;&]*` — NOT `[^|]*` — so the reader and the .env must
  # be in the SAME command. The looser form spanned `;` and matched an unrelated later argument:
  # `head -20 some-file.sh; grep -q 'env.example' other.sh` was blocked though nothing read a .env.
  if echo "$CMD" | grep -Eiq '(cat|less|head|tail|curl|wget)[^|;&]*\.env($|[^.a-zA-Z])'; then
    block "reading a .env via shell. Read config from process env instead."
  fi
  # POWERSHELL. The PowerShell tool's payload carries its script in tool_input.command — the same
  # field as Bash — so every rule above already applies to it (git push --force, reset --hard,
  # DROP TABLE, `cat .env` via the alias). What it does NOT share is the cmdlet vocabulary: TIW
  # agents use the PowerShell tool, and before 2026-09-27 the settings matcher did not even send
  # it here. These are the PowerShell spellings of the two shell rules that are word-bound.
  #   reading a .env: Get-Content / gc / type / Select-String / sls
  if echo "$CMD" | grep -Eiq '(^|[^a-z0-9_-])(get-content|gc|type|select-string|sls)[[:space:]][^|;&]*\.env($|[^.a-zA-Z])'; then
    block "reading a .env via PowerShell. Read config from process env instead."
  fi
  #   recursive force-delete of a root / home / cwd path: Remove-Item (or its aliases) with a
  #   -Recurse and a -Force parameter (any unambiguous prefix, any order) and such a target.
  #   Checked per statement, so a harmless `Remove-Item -Recurse -Force .\dist` stays allowed.
  while IFS= read -r seg; do
    s=" $(printf '%s' "$seg" | tr 'A-Z' 'a-z' | tr -d "\"'") "
    case "$s" in *" remove-item "*|*" ri "*|*" rm "*|*" del "*|*" rd "*|*" rmdir "*|*" erase "*) ;; *) continue ;; esac
    printf '%s' "$s" | grep -Eq '[[:space:]]-r(e|ec|ecu|ecur|ecurs|ecurse)?[[:space:]]' || continue
    printf '%s' "$s" | grep -Eq '[[:space:]]-fo(r|rc|rce)?[[:space:]]' || continue
    if printf '%s' "$s" | grep -Eq '[[:space:]](-path[[:space:]]+|-literalpath[[:space:]]+)?([a-z]:[\/]?|[\/]|~[\/]?|\$home[\/]?|\$env:userprofile[\/]?|\.[\/]?|\*)[[:space:]]'; then
      block "recursive force-delete of a root/home/cwd path (PowerShell). If intended, a human must run it."
    fi
  done <<< "$(printf '%s' "$CMD" | tr ';|&' '\n\n\n')"
  # Client-data scan: never commit raw client data or client identifiers (names/vendors/amounts).
  # Enforced here so a manual pre-push grep can't be forgotten (learned twice). Redact/synthesize.
  # Scans the whole would-be-committed content — `git diff HEAD` ADDED lines (staged AND unstaged, so
  # an `add && commit` in one call is still caught) + untracked-file content — NOT just the index.
  # Only added/new content is scanned, so a REDACTION commit (removing a leaked value) is never blocked.
  if echo "$CMD" | grep -Eq 'git[[:space:]]+commit'; then
    ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}"
    # BINARIES ARE NOT CLIENT TEXT, and their bytes can spell anything: a .glb matched the Greek
    # range by accident (TIW, 2026-09-27). Tracked: numstat's `-<TAB>-` rows are what git itself
    # holds as binary; they are excluded by pathspec, because a textconv driver would otherwise
    # render one into the diff as text. Untracked: `grep -I` in the C locale — a NUL test, git's.
    BIN_EXCL=()
    while IFS=$'\t' read -r -d '' nadd ndel npath; do
      [ "$nadd" = - ] && [ "$ndel" = - ] && BIN_EXCL+=(":(exclude,literal)$npath")
    done < <(git -C "$ROOT" diff HEAD --numstat -z --no-renames 2>/dev/null || true)
    # `grep -a` IS LOAD-BEARING. Without it, ONE NUL anywhere in the diff text (a textconv'd
    # binary, or a file whose first NUL sits past git's 8000-byte sniff) makes grep print
    # "Binary file (standard input) matches" INSTEAD of the lines — every added line of every
    # file in the commit vanished and the Greek and denylist rules passed on nothing. Found by
    # RED-verifying the binary skip, 2026-09-27. NULs are dropped so bash does not warn on them.
    ADDED="$(git -C "$ROOT" diff HEAD -- . ${BIN_EXCL[@]+"${BIN_EXCL[@]}"} 2>/dev/null | grep -aE '^\+' | tr -d '\000' || true)"
    while IFS= read -r -d '' f; do
      LC_ALL=C grep -Iq '' "$ROOT/$f" 2>/dev/null || continue   # binary (or empty): skip
      ADDED="$ADDED
$(cat "$ROOT/$f" 2>/dev/null || true)"
    done < <(git -C "$ROOT" ls-files --others --exclude-standard -z 2>/dev/null || true)
    if [ -n "$ADDED" ]; then
      # (a) Greek script = almost certainly raw client data in this English repo — UNLESS the repo
      # ships Greek on purpose (a game's el locale: TIW has 169 such files). `.claude/.no-greek-scan`
      # turns off (a) ONLY; the denylist (b) still runs. Commit the marker with an ADR saying why.
      if [ ! -f "$ROOT/.claude/.no-greek-scan" ] && printf '%s' "$ADDED" | grep -Pq '[\x{0370}-\x{03FF}]' 2>/dev/null; then
        block "client-data scan: Greek characters in the diff — looks like raw client data. Redact/synthesize before committing."
      fi
      # (b) denylist of known client identifiers (gitignored, local-only; regex per line).
      DENY="$ROOT/.claude/.client-denylist"
      if [ -s "$DENY" ]; then
        PATS="$(grep -vE '^[[:space:]]*(#|$)' "$DENY" || true)"   # strip comments/blanks
        if [ -n "$PATS" ] && printf '%s' "$ADDED" | grep -Eq -f <(printf '%s' "$PATS") 2>/dev/null; then
          block "client-data scan: diff contains a denylisted client identifier (see .claude/.client-denylist). Redact/synthesize before committing."
        fi
      fi
    fi
  fi
fi
exit 0
