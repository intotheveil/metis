#!/usr/bin/env bash
# SubagentStop gate. Enforces CLAUDE.md non-negotiables for code-producing subagents
# before their work is accepted. Exit 2 forces rework.
#
# House default: npm. Each check runs ONLY if the project defines that script, so the gate
# never blocks a project that hasn't defined one — but it no longer skips in SILENCE.
#
# WHY THE SCOPE LINE EXISTS. Measured across the fleet 2026-09-11: hr-checkin defines
# neither `lint` nor `typecheck`, so a builder there passed this gate having run TESTS ONLY,
# and the output was indistinguishable from a repo where all three ran. ares and pipepro-wms
# have no `typecheck`; pluto has no `lint`. A gate that reports success while checking less
# than it appears to is the same defect class as a reviewer grading against a §6 that does
# not exist. So: every run now declares what it RAN and what it SKIPPED, and a skip names
# the reason. What was not checked is load-bearing information.
#
# ZEUS_STRICT=1 turns any skipped check into a hard failure — for CI and for a release gate,
# where "we couldn't check" must never read as "it passed".
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/_json.sh"

INPUT="$(cat)"
AGENT_TYPE="$(printf '%s' "$INPUT" | jget '.agent_type')"
cd "${CLAUDE_PROJECT_DIR:-.}"

RAN=""; SKIPPED=""
note_ran()     { RAN="$RAN $1"; }
note_skipped() { SKIPPED="$SKIPPED $1($2)"; }

# CONF_NOTE is empty unless .claude/gate.conf exists, so a repo without one prints exactly the
# scope line it always did (test-kit pins that byte-for-byte against the pre-gate.conf hook).
CONF_NOTE=""
scope_line() {
  echo "SUBAGENT GATE ($AGENT_TYPE) scope: ran[${RAN:- none}] skipped[${SKIPPED:- none}]${CONF_NOTE}" >&2
}
fail() { scope_line; echo "SUBAGENT GATE FAILED ($AGENT_TYPE): $1" >&2; exit 2; }

has_script() { grep -q "\"$1\"[[:space:]]*:" package.json 2>/dev/null; }

# 0) ONE GATE PER CHECKOUT. Two code-producing agents in one working tree share one index and
# one suite: builder A's half-done contract change turned builder B's gate red, and B burned
# seven full suite runs finding that its own diff was clean (zeus-hq BRAIN §5, "two builders
# deadlock"). A lock cannot make a shared tree exclusive — separate worktrees do that — but it
# stops two gates running over each other and says so IMMEDIATELY, naming the fix.
#
# The lock lives in `git rev-parse --git-dir`, which is PER WORKTREE (.git/worktrees/<name> in
# a linked one), so agents in separate worktrees never contend. It is created atomically
# (noclobber = O_EXCL) and holds "<pid> <epoch>". A lock whose pid is dead, or that is older
# than ZEUS_GATE_LOCK_TTL seconds (default 1800, far past any real gate run, so an older lock
# means a reused pid rather than a live gate), is STALE: named, removed and retaken once, so a
# killed gate can never wedge a checkout.
LOCK=""
own_lock() { [ -n "$LOCK" ] && [ "$(cut -d' ' -f1 "$LOCK" 2>/dev/null)" = "$$" ]; }
release_lock() { own_lock && rm -f "$LOCK"; return 0; }
if GITDIR="$(git rev-parse --git-dir 2>/dev/null)"; then
  LOCK="$GITDIR/zeus-gate.lock"
  TTL="${ZEUS_GATE_LOCK_TTL:-1800}"
  for _attempt in 1 2; do
    if ( set -o noclobber; printf '%s %s\n' "$$" "$(date +%s)" > "$LOCK" ) 2>/dev/null; then
      trap release_lock EXIT
      break
    fi
    HOLDER=""; STARTED=""
    read -r HOLDER STARTED < "$LOCK" 2>/dev/null || true
    AGE=$(( $(date +%s) - ${STARTED:-0} ))
    if [ -n "$HOLDER" ] && kill -0 "$HOLDER" 2>/dev/null && [ "$AGE" -lt "$TTL" ]; then
      echo "SUBAGENT GATE BUSY ($AGENT_TYPE): another gate (pid $HOLDER, running ${AGE}s) holds $LOCK." >&2
      echo "Two agents are gating ONE checkout. Serialise the builders, or give each its own git worktree (isolation: worktree). Do not retry in a loop." >&2
      exit 2
    fi
    echo "SUBAGENT GATE: removing stale lock $LOCK (pid ${HOLDER:-?} not running, or lock ${AGE}s old)." >&2
    rm -f "$LOCK"
  done
  own_lock || { echo "SUBAGENT GATE BUSY ($AGENT_TYPE): lost the race for $LOCK after clearing a stale lock. Serialise, or use a worktree." >&2; exit 2; }
fi

# 1) No secrets in the staged diff.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  if git diff --cached -U0 2>/dev/null | grep -Eiq '(sk-[a-zA-Z0-9]{20,})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)|service_role.*eyJ[A-Za-z0-9_-]{20,}'; then
    fail "a secret appears in the staged diff. Remove it before this work is accepted."
  fi
  note_ran "secret-scan"
else
  note_skipped "secret-scan" "no git"
fi

# Strict check lives in a function because there is more than one exit path, and the first
# version of this file put it only on the LAST one — so a repo with no package.json reported
# three skipped checks and still exited 0 under ZEUS_STRICT=1. A strict mode that is silently
# bypassed by the very case it exists to catch is worse than none.
finish() {
  scope_line
  if [ -n "${ZEUS_STRICT:-}" ] && [ -n "$SKIPPED" ]; then
    echo "SUBAGENT GATE FAILED ($AGENT_TYPE): ZEUS_STRICT=1 and these checks could not run:${SKIPPED}." >&2
    if [ -n "$CONF_NOTE" ]; then
      echo "Install the missing tool(s) / fix .claude/gate.conf, or clear ZEUS_STRICT for local work." >&2
    else
      echo "Define the missing npm script(s) in this repo, or clear ZEUS_STRICT for local work." >&2
    fi
    exit 2
  fi
  exit 0
}

# 1b) OPTIONAL PER-REPO CONFIG: .claude/gate.conf. Without it the gate knows one shape — npm
# scripts at the repo root — and that is wrong for three games measured 2026-09-27: Globebound
# and Hollowmere keep package.json under web/, and ICCAID is Godot, whose binary is not on PATH.
# Absent file = the behaviour above and below, unchanged.
#
#   dir=web                     run the checks in this subdirectory (relative, no `..`)
#   cmd.<name>=<command>        declare the checks explicitly, run in file order via bash -c.
#                               If ANY cmd.* line exists, ONLY those run — no npm autodetect.
#   # comment, blank lines      ignored
#
# `$GODOT_BIN` may be used in a command. If the environment does not set it, the gate looks for
# godot4 then godot on PATH. A check whose tool (first word, after expanding a leading $VAR)
# cannot be found is SKIPPED with the reason in the scope line — never run-and-failed, never
# silently dropped — and ZEUS_STRICT=1 still turns that skip into a failure. An unknown key is
# a skip too: a typo in a gate config must not quietly remove a check.
CONF=".claude/gate.conf"
GATE_DIR="."; CMD_NAMES=""; declare -A CMD_OF=()
if [ -f "$CONF" ]; then
  CONF_NOTE=" config[$CONF]"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
    val="${val#"${val%%[![:space:]]*}"}"
    if [ "$key" = "$line" ]; then note_skipped "gate.conf" "not key=value: $line"; continue; fi
    case "$key" in
      dir)
        case "$val" in
          /*|[A-Za-z]:*|..|../*|*/..|*/../*) note_skipped "gate.conf" "dir must be relative without ..: $val" ;;
          *) GATE_DIR="$val"; CONF_NOTE=" config[$CONF dir=$val]" ;;
        esac ;;
      cmd.*)
        name="${key#cmd.}"
        case "$name" in ''|*[!A-Za-z0-9_-]*) note_skipped "gate.conf" "bad check name: $key"; continue ;; esac
        case " $CMD_NAMES " in *" $name "*) ;; *) CMD_NAMES="$CMD_NAMES $name" ;; esac
        CMD_OF[$name]="$val" ;;
      *) note_skipped "gate.conf" "unknown key: $key" ;;
    esac
  done < "$CONF"

  if [ ! -d "$GATE_DIR" ]; then
    for c in ${CMD_NAMES:-typecheck lint test}; do note_skipped "$c" "gate.conf dir '$GATE_DIR' not found"; done
    finish
  fi

  if [ -z "${GODOT_BIN:-}" ]; then
    for g in godot4 godot; do command -v "$g" >/dev/null 2>&1 && { GODOT_BIN="$(command -v "$g")"; break; }; done
  fi
  export GODOT_BIN="${GODOT_BIN:-}"

  if [ -n "$CMD_NAMES" ]; then
    for name in $CMD_NAMES; do
      c="${CMD_OF[$name]}"
      if [ -z "$c" ]; then note_skipped "$name" "empty command"; continue; fi
      read -r tool _ <<< "$c"
      tool="${tool#\"}"; tool="${tool%\"}"
      case "$tool" in
        \$\{*\}|\$[A-Za-z_]*)
          var="${tool#\$}"; var="${var#\{}"; var="${var%\}}"
          case "$var" in *[!A-Za-z0-9_]*) note_skipped "$name" "cannot resolve tool $tool"; continue ;; esac
          if [ -z "${!var:-}" ]; then note_skipped "$name" "$var unset and no tool found"; continue; fi
          tool="${!var}" ;;
      esac
      if ! command -v "$tool" >/dev/null 2>&1 && [ ! -x "$tool" ]; then
        note_skipped "$name" "tool '$tool' not found"; continue
      fi
      ( cd "$GATE_DIR" && bash -c "$c" ) || fail "check '$name' failed ($c). Fix the code (do NOT weaken tests) before completing."
      note_ran "$name"
    done
    finish
  fi
  cd "$GATE_DIR"
fi

if [ ! -f package.json ]; then
  note_skipped "typecheck" "no package.json"
  note_skipped "lint" "no package.json"
  note_skipped "test" "no package.json"
  finish
fi

# 2) Typecheck clean (if defined).
if has_script typecheck; then
  npm run typecheck --silent || fail "typecheck failed. Fix types before completing."
  note_ran "typecheck"
else
  note_skipped "typecheck" "no script"
fi

# 3) Lint clean (if defined).
if has_script lint; then
  npm run lint --silent || fail "lint failed. Fix before completing."
  note_ran "lint"
else
  note_skipped "lint" "no script"
fi

# 4) Tests pass (if defined). Core non-negotiable when present.
if has_script test; then
  npm test --silent || fail "test suite is red. Fix the code (do NOT weaken tests) before completing."
  note_ran "test"
else
  note_skipped "test" "no script"
fi

finish
