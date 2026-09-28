# Sourced by the other hooks. Provides jget() to read a field from the hook JSON
# on stdin, using jq if present, otherwise python3. One of the two exists on any
# machine that can run Claude Code + a JS/Python toolchain.
#
# Usage: VALUE="$(printf '%s' "$INPUT" | jget '.tool_input.file_path')"
# The path is a dotted path; python fallback supports simple .a.b.c lookups and
# the "// empty" idiom is emulated by returning empty string on miss.

jget() {
  local path="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r "${path} // empty" 2>/dev/null
  else
    # Strip a leading dot, split on dots, walk the dict. Missing -> "".
    python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print(""); sys.exit(0)
path = sys.argv[1].lstrip(".")
cur = d
for part in path.split("."):
    if isinstance(cur, dict) and part in cur and cur[part] is not None:
        cur = cur[part]
    else:
        print(""); sys.exit(0)
print(cur if isinstance(cur, str) else json.dumps(cur))
' "$path"
  fi
}

# emit_block_json <reason>  — prints a PostToolUse/Stop style block decision.
emit_block_json() {
  local reason="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -n --arg r "$reason" '{decision:"block", reason:$r}'
  else
    python3 -c 'import json,sys; print(json.dumps({"decision":"block","reason":sys.argv[1]}))' "$reason"
  fi
}
