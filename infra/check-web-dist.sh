#!/usr/bin/env bash
# PWA 产物发布前的兜底自检。deploy.sh 与 Vercel 构建共用同一份 ——
# 复制两份必然漂移,而这里漂移一次就等于把测试注入面发到生产。
# 用法:VITE_API_BASE=… infra/check-web-dist.sh <dist 目录>
set -euo pipefail
DIST="${1:?用法:check-web-dist.sh <dist 目录>}"
: "${VITE_API_BASE:?缺少环境变量 VITE_API_BASE}"

[[ -f "$DIST/index.html" ]] || { echo "✗ $DIST 里没有 index.html —— 构建根本没出产物"; exit 1; }

# ① 生产产物不得含测试注入面(m1-99 B6)。不依赖"我记得没设 VITE_M1_TEST_HOOKS"。
if grep -rl --include='*.js' '__amr' "$DIST" >/dev/null 2>&1; then
  echo "✗ 生产产物含测试注入面 __amr —— 拒绝发布"; exit 1
fi
# ② VITE_API_BASE 是**构建期**变量。在 Vercel 上把它配成 Runtime 变量不会报错,
#    只会静默烤进默认值,PWA 上线后打到错误的后端。所以必须在产物里看见它。
if ! grep -rqF --include='*.js' -- "$VITE_API_BASE" "$DIST" 2>/dev/null; then
  echo "✗ 产物中找不到 VITE_API_BASE=$VITE_API_BASE —— 构建期变量未生效,PWA 会打到错误的后端"; exit 1
fi
echo "  ✓ PWA 产物就绪:$DIST(API base = $VITE_API_BASE,无注入面)"
