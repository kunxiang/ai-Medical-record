#!/usr/bin/env bash
# M1 验收编排(spec m1-99)。用法: bash infra/run-m1.sh [--keep]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/infra/docker-compose.yml"
export AUTH_SECRET="m1-acceptance-secret-0123456789abcdef"
export DATABASE_URL="postgres://amr:amr@localhost:5432/amr"
export S3_ENDPOINT="http://localhost:9000"
export S3_BUCKET="medical-record"
export REPO_ROOT="$ROOT"
export WEB_ORIGIN="http://localhost:5173"
export WEB_URL="http://localhost:5173"
export API_URL="http://localhost:8300"

cleanup() {
  for pid in "${API_PID:-}" "${WEB_PID:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
  if [[ "${KEEP:-}" != "--keep" ]]; then $COMPOSE down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
KEEP="${1:-}"

echo "== 清场 =="
$COMPOSE down -v >/dev/null 2>&1 || true
command -v fuser >/dev/null && fuser -k 8300/tcp 5173/tcp 2>/dev/null || true

echo "== compose up =="
$COMPOSE up -d --wait

echo "== MinIO 应用用户与策略 =="
$COMPOSE exec -T minio mc alias set local http://localhost:9000 amr-admin amr-admin-secret >/dev/null
$COMPOSE exec -T minio mc admin user add local amr-app amr-app-secret >/dev/null 2>&1 || true
$COMPOSE cp "$ROOT/infra/minio-app-policy.json" minio:/tmp/app-policy.json >/dev/null
$COMPOSE exec -T minio mc admin policy create local amr-app-policy /tmp/app-policy.json >/dev/null 2>&1 || true
$COMPOSE exec -T minio mc admin policy attach local amr-app-policy --user amr-app >/dev/null 2>&1 || true

echo "== migrate + provision(含 CORS)+ _meta + seed =="
pnpm --filter @amr/api --silent run db:migrate
pnpm --filter @amr/tools --silent run provision-bucket
pnpm --filter @amr/tools --silent run gen-meta
pnpm --filter @amr/tools --silent run seed-account

echo "== 生成 fixtures =="
[[ -f "$ROOT/fixtures/m1/manifest.json" ]] || pnpm --filter @amr/tools --silent run gen-m1-fixtures

echo "== 构建 web(含测试注入面)=="
( cd "$ROOT/apps/web" && VITE_M1_TEST_HOOKS=1 VITE_API_BASE="$API_URL" VITE_FIXTURE_BASE=/fixtures npx vite build >/dev/null )
# fixtures 通过静态服务暴露给页面(测试注入面用 fetch 读取)
mkdir -p "$ROOT/apps/web/dist/fixtures"
cp "$ROOT"/fixtures/m1/*.jpg "$ROOT"/fixtures/m1/*.png "$ROOT"/fixtures/m1/*.pdf "$ROOT/apps/web/dist/fixtures/" 2>/dev/null || true

echo "== 启动 API 与静态服务 =="
( cd "$ROOT/apps/api" && M0_TEST_HOOKS=1 PORT=8300 npx tsx src/main.ts ) & API_PID=$!
( cd "$ROOT/apps/web" && npx vite preview --port 5173 --strictPort >/dev/null ) & WEB_PID=$!

for i in $(seq 1 90); do
  api_ok=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/v1/auth/login" \
    -H 'content-type: application/json' -d '{"email":"x@x.io","password":"xx"}' || echo 000)
  web_ok=$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/" || echo 000)
  [[ "$api_ok" =~ ^4 ]] && [[ "$web_ok" == "200" ]] && break
  sleep 1
  if [[ $i == 90 ]]; then echo "服务启动超时 api=$api_ok web=$web_ok"; exit 1; fi
done

echo "== A 组验收(Playwright)=="
( cd "$ROOT/tools" && npx tsx src/m1-acceptance.ts )

echo "== B 组 CI 断言 =="
pnpm --filter @amr/tools --silent run ci:deps          # m1-99 B1/B5/B6/B7/B8/B12
pnpm --filter @amr/storage --silent run test           # m1-99 B2
pnpm --filter @amr/contracts --silent run test         # m1-99 B11
echo "== M1 验收完成 =="
