#!/bin/bash
# 璇玑前端门禁 —— 移动端适配 + 主题桥接 + 类型检查 + 构建（宿主执行）
#
# 用法：bash gate.sh [源码目录]
#   默认 /data/stack/build/tsc-gate（源码由 dsh 容器 tar 同步到此，含 node_modules，勿删）
#
# 2026-11-11 碧霄修（此前脚本三处缺陷、压根跑不起来）：
#   ① 第 12 行行尾多一个引号 → bash -n 语法错，整脚本一执行就死；
#   ② 宿主没装 node → 两道静态审计闸无法在宿主跑；
#   ③ tools/mobile-audit.mjs 只存在于 dsh 容器的工作目录、不在仓库里 → 闸1 找不到脚本。
#   现改为：静态闸一律进 local/xuanji-check 容器内跑（容器有 node），
#   审计脚本随仓库入库（tools/mobile-audit.mjs），审计根目录显式传 --repo /work。
set -uo pipefail

GATE_DIR="${1:-/data/stack/build/tsc-gate}"
CHECK_IMAGE="${XJ_CHECK_IMAGE:-local/xuanji-check:latest}"

cd "$GATE_DIR" || { echo "GATE_ABORT: 源码目录不存在: $GATE_DIR"; exit 2; }
echo "=== 闸门目录: $GATE_DIR ==="
echo "=== 文件数: $(find . -path ./node_modules -prune -o -name '*.tsx' -print | wc -l) tsx ==="

docker run --rm -v "$GATE_DIR":/work -w /work "$CHECK_IMAGE" bash -lc '
  set -uo pipefail
  echo "--- 静态巡检（移动端硬红线）---"
  node tools/mobile-audit.mjs --repo /work | tail -2; AUDIT=${PIPESTATUS[0]}
  echo "--- 主题桥接守卫（shadcn 变量覆盖 + 防漂移）---"
  node tools/theme-bridge-audit.mjs | tail -2; BRIDGE=${PIPESTATUS[0]}
  if [ "$AUDIT" != "0" ] || [ "$BRIDGE" != "0" ]; then
    echo "GATE_ABORT: 静态门禁未通过 (AUDIT=$AUDIT BRIDGE=$BRIDGE)"
    exit 1
  fi
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
GATE=$?
echo "=== GATE_EXIT=$GATE ==="
exit $GATE
