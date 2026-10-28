#!/bin/bash
# 采集当前浏览器会话的网络请求并脱敏入库
# 用法: bash capture.sh <阶段名> [--clear]
# 原始文件只落在临时目录，脱敏后才写入项目 evidence/
set -u
export PATH="C:/Users/Agust/.workbuddy/binaries/node/versions/22.22.2:$PATH"

PHASE="${1:?需要阶段名}"
TMPDIR_WIN="C:/Users/Agust/.workbuddy/tmp-har"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTDIR="$ROOT/evidence"
PY="C:/Users/Agust/.workbuddy/binaries/python/versions/3.13.12/python.exe"
SANI="$ROOT/scripts/sanitize_evidence.py"

mkdir -p "$TMPDIR_WIN" "$OUTDIR"
RAW="$TMPDIR_WIN/raw_${PHASE}.json"

agent-browser --session "${AGENT_BROWSER_SESSION:-oms-recheck}" --json network requests > "$RAW" 2>/dev/null
"$PY" "$SANI" "$RAW" "$OUTDIR/network_${PHASE}.json" >/dev/null

COUNT=$("$PY" -c "import json,sys;d=json.load(open(r'$RAW',encoding='utf-8'));print(len(d.get('data',{}).get('requests',[])))")
echo "phase=$PHASE requests=$COUNT raw=$RAW sanitized=$OUTDIR/network_${PHASE}.json"

if [ "${2:-}" = "--clear" ]; then
  agent-browser --session "${AGENT_BROWSER_SESSION:-oms-recheck}" --json network requests --clear >/dev/null 2>&1
  echo "cleared request log"
fi
