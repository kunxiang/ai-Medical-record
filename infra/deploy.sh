#!/usr/bin/env bash
# 首次部署 / 更新部署。见 docs/11-deployment.md。
# 用法:
#   infra/deploy.sh build          仅构建(API + PWA)
#   infra/deploy.sh migrate        仅跑数据库迁移
#   infra/deploy.sh provision      仅配置桶(需 S3_ADMIN_* 凭证)
#   infra/deploy.sh all            build + migrate + provision + gen-meta
#   infra/deploy.sh smoke          对当前 API_URL 跑部署冒烟
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() { [[ -n "${!1:-}" ]] || { echo "缺少环境变量 $1"; exit 2; }; }

do_build() {
  echo "== 构建 =="
  pnpm install --frozen-lockfile
  pnpm -r build
  need VITE_API_BASE
  # ★ 绝不设 VITE_M1_TEST_HOOKS —— 生产产物不得含测试注入面(m1-99 B6)
  ( cd apps/web && VITE_API_BASE="$VITE_API_BASE" npx vite build )
  # 兜底自检与 Vercel 构建共用同一份脚本,免得两处漂移(infra/check-web-dist.sh)
  bash infra/check-web-dist.sh apps/web/dist
}

do_migrate() { need DATABASE_URL; echo "== 迁移 =="; pnpm --filter @amr/api --silent run db:migrate; }

do_provision() {
  need S3_ENDPOINT; need S3_BUCKET; need S3_ADMIN_KEY; need S3_ADMIN_SECRET; need WEB_ORIGIN
  echo "== 桶配置(需 admin 档凭证;配完可降回对象级)=="
  pnpm --filter @amr/tools --silent run provision-bucket
}

do_meta() { echo "== _meta 自述层 =="; pnpm --filter @amr/tools --silent run gen-meta; }

do_smoke() { need API_URL; echo "== 部署冒烟 =="; pnpm --filter @amr/tools --silent run deploy-smoke; }

case "${1:-all}" in
  build) do_build ;;
  migrate) do_migrate ;;
  provision) do_provision ;;
  meta) do_meta ;;
  smoke) do_smoke ;;
  all) do_build; do_migrate; do_provision; do_meta
       echo; echo "部署就绪。起 API:node apps/api/dist/main.js"
       echo "然后跑冒烟:API_URL=… infra/deploy.sh smoke" ;;
  *) echo "未知子命令:$1"; exit 2 ;;
esac
