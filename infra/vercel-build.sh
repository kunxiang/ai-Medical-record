#!/usr/bin/env bash
# Vercel 上只构建 PWA 前端(apps/web)。API 不在 Vercel 上跑 —— 见 docs/11-deployment.md §Vercel。
# Vercel 项目设置:Root Directory = 仓库根,Build Command / Output Directory 由 vercel.json 指定。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
: "${VITE_API_BASE:?缺少环境变量 VITE_API_BASE(须在 Vercel 项目里配为构建期变量)}"

# web 依赖 @amr/contracts 的 d.ts 与 js,先建它;api/tools 不需要,别在 Vercel 上白建。
pnpm --filter @amr/contracts build
( cd apps/web && VITE_API_BASE="$VITE_API_BASE" npx vite build )
bash infra/check-web-dist.sh apps/web/dist
