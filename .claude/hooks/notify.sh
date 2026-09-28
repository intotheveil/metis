#!/usr/bin/env bash
# Stop hook. Desktop-notifies when the lead session pauses (checkpoint). Best-effort.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/_json.sh"
INPUT="$(cat)"
LAST="$(printf '%s' "$INPUT" | jget '.last_assistant_message' | head -c 180)"
[ -z "$LAST" ] && LAST="Claude Code reached a checkpoint."
MSG="Checkpoint: $LAST"
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"$MSG\" with title \"Claude Code crew\"" >/dev/null 2>&1 || true
elif command -v notify-send >/dev/null 2>&1; then
  notify-send "Claude Code crew" "$MSG" >/dev/null 2>&1 || true
fi
echo "$(date '+%Y-%m-%d %H:%M:%S')  $MSG" >> "${CLAUDE_PROJECT_DIR:-.}/.claude/checkpoints.log" 2>/dev/null || true
exit 0
