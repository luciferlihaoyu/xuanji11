#!/bin/bash
# 璇玑移动端适配 —— 类型检查 + 构建闸（在宿主机上跑，容器内执行）
# 用法：bash /data/stack/build/gate.sh
# 说明：源码由 dsh 容器 tar 同步到 /data/stack/build/tsc-gate（含 node_modules，勿删除）
set -uo pipefail
cd /data/stack/build/tsc-gate || exit 2
echo "=== 文件数: $(find . -path ./node_modules -prune -o -name '*.tsx' -print | wc -l) tsx ==="
echo "--- 静态巡检（移动端硬红线）---"
node tools/mobile-audit.mjs | tail -2; AUDIT=${PIPESTATUS[0]}
echo "--- 主题桥接守卫（shadcn 变量覆盖 + 防漂移）---"
node tools/theme-bridge-audit.mjs | tail -2; BRIDGE=${PIPESTATUS[0]}
if [ "$AUDIT" != "0" ] || [ "$BRIDGE" != "0" ]; then echo "GATE_ABORT: 静态门禁未通过"; exit 1; fi"
docker run --rm -v /data/stack/build/tsc-gate:/work -w /work local/xuanji-check:latest bash -lc '
  echo "--- tsc -b ---"
  npx tsc -b; TSC=$?
  echo "TSC_EXIT=$TSC"
  if [ $TSC -ne 0 ]; then exit $TSC; fi
  echo "--- vite + esbuild build ---"
  npm run build >/tmp/build.log 2>&1; B=$?
  echo "BUILD_EXIT=$B"
  tail -12 /tmp/build.log
  ls -la dist | head -5
  exit $B
'
