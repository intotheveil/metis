#!/usr/bin/env bash
# Stop/SessionEnd hook. Checks whether BRAIN.md was updated this session. If work happened
# (files changed) but BRAIN.md wasn't touched, it reminds — the brain must be written before
# ending. Non-blocking reminder by default (exit 0 with message); can be made blocking.
set -euo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}"

[ -f BRAIN.md ] || exit 0   # no brain in this repo yet, nothing to enforce

# Did any tracked file change this session but BRAIN.md is not among the recently-modified?
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  CHANGED="$(git status --short 2>/dev/null | wc -l)"
  BRAIN_TOUCHED="$(git status --short 2>/dev/null | grep -c 'BRAIN.md' || true)"
  if [ "$CHANGED" -gt 0 ] && [ "$BRAIN_TOUCHED" -eq 0 ]; then
    echo "⚠️  BRAIN REMINDER: files changed this session but BRAIN.md was not updated." >&2
    echo "   Update §3 CURRENT STATE, append a §6 CHANGELOG entry, record any §5 GOTCHAS," >&2
    echo "   before ending. The brain is the memory — an unwritten session is a lost session." >&2
  fi
fi
exit 0
