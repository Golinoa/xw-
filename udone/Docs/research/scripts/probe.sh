#!/bin/bash
# 页面结构化探针：把当前页面的表单/表格/按钮/导航/文本采集成脱敏 JSON
# 用法: bash probe.sh <页面标识> [url]
set -u
export PATH="C:/Users/Agust/.workbuddy/binaries/node/versions/22.22.2:$PATH"

KEY="${1:?需要页面标识}"
URL="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="C:/Users/Agust/.workbuddy/tmp-har"
PY="C:/Users/Agust/.workbuddy/binaries/python/versions/3.13.12/python.exe"
OUT="$ROOT/evidence/pages"
mkdir -p "$TMP" "$OUT"

if [ -n "$URL" ]; then
  agent-browser --session "${AGENT_BROWSER_SESSION:-oms-recheck}" --json open "$URL" >/dev/null 2>&1
  sleep 2
fi

JS="$(cat "$ROOT/scripts/probe_page.js")"
RAW="$TMP/page_${KEY}.json"
agent-browser --session "${AGENT_BROWSER_SESSION:-oms-recheck}" --json eval "$JS" > "$RAW" 2>/dev/null

"$PY" - "$RAW" "$OUT/${KEY}.json" <<'EOF'
import json, sys, re
raw = open(sys.argv[1], encoding="utf-8").read()
try:
    outer = json.loads(raw)
    inner = outer.get("data", {}).get("result")
    data = json.loads(inner) if isinstance(inner, str) else inner
except Exception as e:
    data = {"error": f"probe parse failed: {e}", "raw_head": raw[:500]}

def mask(v):
    if not isinstance(v, str):
        return v
    v = re.sub(r"(?<!\d)(1[3-9]\d{9})(?!\d)", lambda m: m.group(1)[:3] + "****" + m.group(1)[-4:], v)
    v = re.sub(r"(?<!\d)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d)", lambda m: m.group(1) + "." + m.group(2) + ".***.***", v)
    v = re.sub(r"[\w.+-]+@[\w-]+\.[\w.-]+", lambda m: m.group(0)[:1] + "***@" + m.group(0).split("@", 1)[1], v)
    return v

def walk(n):
    if isinstance(n, dict):
        return {k: walk(v) for k, v in n.items()}
    if isinstance(n, list):
        return [walk(x) for x in n]
    return mask(n)

json.dump(walk(data), open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"probe -> {sys.argv[2]}")
EOF
