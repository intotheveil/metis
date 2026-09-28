#!/usr/bin/env bash
# PostToolUse (Write|Edit). Scans the just-written file for hardcoded secrets and
# feeds a block reason back so the agent removes the secret before proceeding.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$DIR/_json.sh"

INPUT="$(cat)"
FILE="$(printf '%s' "$INPUT" | jget '.tool_input.file_path')"
[ -z "$FILE" ] && FILE="$(printf '%s' "$INPUT" | jget '.inputs.file_path')"
[ -z "$FILE" ] && exit 0
[ -f "$FILE" ] || exit 0

HITS="$(grep -nEi \
  '(sk-[a-zA-Z0-9]{20,})|(aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+]{30,})|(-----BEGIN [A-Z ]*PRIVATE KEY-----)|(service_role.*eyJ[A-Za-z0-9_-]{20,})' \
  "$FILE" 2>/dev/null || true)"

if [ -n "$HITS" ]; then
  emit_block_json "Possible hardcoded secret in $FILE. Remove it and load from env before continuing:
$HITS"
fi
exit 0
