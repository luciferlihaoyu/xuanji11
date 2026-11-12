#!/bin/bash
# 璇玑前端门禁 —— 移动端适配 + 主题桥接 + 类型检查 + 全量单测 + 构建（宿主执行）
#
# 用法：bash gate.sh [源码目录]
#   默认 /data/stack/build/tsc-gate（源码由 dsh 容器 tar 同步到此，含 node_modules，勿删）
#
# 可选环境变量：
#   XJ_REPO=/data/stack/src/xuanji11   与仓库比对源码指纹；不一致直接 GATE_ABORT
#                                       （闸门目录是**副本**，一旦忘了同步，"绿"就毫无意义）
#   XJ_CHECK_IMAGE=local/xuanji-check:latest
#
# 2026-11-11 碧霄修（此前脚本三处缺陷、压根跑不起来）：
#   ① 第 12 行行尾多一个引号 → bash -n 语法错，整脚本一执行就死；
#   ② 宿主没装 node → 两道静态审计闸无法在宿主跑；
#   ③ tools/mobile-audit.mjs 只存在于 dsh 容器的工作目录、不在仓库里 → 闸1 找不到脚本。
#   现改为：静态闸一律进 local/xuanji-check 容器内跑（容器有 node），
#   审计脚本随仓库入库（tools/mobile-audit.mjs），审计根目录显式传 --repo /work。
#
# 2026-11-12 碧霄加第四道闸（全量单测，零失败才过）：
#   此前门禁只跑 tsc + build + 静态审计，**从不跑 vitest** —— 于是
#   kb-backup(×2) / mcp-reindex / egress-ratchet 这 4 处红**潜伏了一个月没人发现**，
#   灾备恢复路径整整一个月没有测试保护。
#   现在把全量 vitest 纳入门禁：新增失败立即挡住合并/部署。
#   代价：门禁多花约 2 分钟（容器内跑，宿主无 node）。
#
# 2026-11-12 碧霄补三处护栏（天演评审）：
#   ④ vitest 输出带 ANSI 彩码 → 原 grep "Tests  " 永远不匹配（只打出 Test Files 一行）。
#      现在 NO_COLOR=1 关彩码，grep 改为容忍的 "Tests"。
#   ⑤ 外层 docker run 无超时 → 任一用例挂死会让门禁无限期卡住。加 timeout 900s（124=超时）。
#   ⑥ 闸门目录是源码**副本** → 忘了同步时，闸门验的其实不是待提交的那份代码。
#      现在打印源码指纹，并在给出 XJ_REPO 时与仓库比对，不一致直接拦。
set -uo pipefail

GATE_DIR="${1:-/data/stack/build/tsc-gate}"
CHECK_IMAGE="${XJ_CHECK_IMAGE:-local/xuanji-check:latest}"

cd "$GATE_DIR" || { echo "GATE_ABORT: 源码目录不存在: $GATE_DIR"; exit 2; }
echo "=== 闸门目录: $GATE_DIR ==="
echo "=== 文件数: $(find . -path ./node_modules -prune -o -name '*.tsx' -print | wc -l) tsx ==="

# ---- 源码指纹（副本 vs 仓库，防"忘了同步还绿"）----
tree_fingerprint() {
  ( cd "$1" 2>/dev/null && find . -path ./node_modules -prune -o -path ./dist -prune -o \
      -path ./.git -prune -o -path ./shots -prune -o -type f -print0 2>/dev/null \
    | sort -z | xargs -0 md5sum 2>/dev/null | md5sum | cut -c1-16 )
}
GATE_FP=$(tree_fingerprint "$GATE_DIR")
echo "=== 闸门源码指纹: ${GATE_FP:-<无法计算>} ==="
if [ -n "${XJ_REPO:-}" ]; then
  REPO_FP=$(tree_fingerprint "$XJ_REPO")
  echo "=== 仓库源码指纹: ${REPO_FP:-<无法计算>} ($XJ_REPO) ==="
  if [ -z "$GATE_FP" ] || [ -z "$REPO_FP" ]; then
    echo "GATE_ABORT: 无法计算源码指纹 —— 不能证明闸门验的是哪份代码"
    exit 3
  fi
  if [ "$GATE_FP" != "$REPO_FP" ]; then
    echo "GATE_ABORT: 闸门源码与仓库不一致（$GATE_FP vs $REPO_FP）—— 绿得没有意义，先同步再验"
    exit 3
  fi
  echo "OK: 闸门源码与仓库一致"
fi

timeout 900 docker run --rm -v "$GATE_DIR":/work -w /work "$CHECK_IMAGE" bash -lc '
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
  echo "--- 全量单测（vitest run，要求零失败）---"
  NO_COLOR=1 npx vitest run >/tmp/vitest.log 2>&1; V=$?
  echo "VITEST_EXIT=$V"
  grep -E "Test Files|Tests" /tmp/vitest.log | tail -3
  if [ $V -ne 0 ]; then
    echo "--- 失败清单（首 25 条）---"
    grep -E "FAIL|×" /tmp/vitest.log | head -25
    echo "GATE_ABORT: 单测有失败 —— 新红必须先修，不许带红合入"
    exit $V
  fi
  echo "--- vite + esbuild build ---"
  npm run build >/tmp/build.log 2>&1; B=$?
  echo "BUILD_EXIT=$B"
  tail -12 /tmp/build.log
  ls -la dist | head -5
  exit $B
'
GATE=$?
if [ $GATE -eq 124 ]; then
  echo "=== GATE_ABORT: 门禁超时（900s）—— 可能有用例挂死 ==="
fi
echo "=== GATE_EXIT=$GATE ==="
exit $GATE
