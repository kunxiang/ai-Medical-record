#!/usr/bin/env bash
# M0 验收编排(spec m0-99)。用法: bash infra/run-m0.sh [--keep]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE="docker compose -f $ROOT/infra/docker-compose.yml"
export AUTH_SECRET="m0-acceptance-secret-0123456789abcdef"
export DATABASE_URL="postgres://amr:amr@localhost:5432/amr"
export S3_ENDPOINT="http://localhost:9000"
export S3_BUCKET="medical-record"
export REPO_ROOT="$ROOT"

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${API2_PID:-}" ]] && kill "$API2_PID" 2>/dev/null || true
  if [[ "${1:-}" != "--keep" ]]; then $COMPOSE down -v >/dev/null 2>&1 || true; fi
}
trap 'cleanup "${KEEP:-}"' EXIT
KEEP="${1:-}"

echo "== 清场(验收必须从洁净环境起跑)=="
$COMPOSE down -v >/dev/null 2>&1 || true

echo "== compose up =="
$COMPOSE up -d --wait

echo "== MinIO 应用用户与策略(无 BypassGovernanceRetention,无 L1 DeleteObject)=="
$COMPOSE exec -T minio mc alias set local http://localhost:9000 amr-admin amr-admin-secret >/dev/null
$COMPOSE exec -T minio mc admin user add local amr-app amr-app-secret >/dev/null 2>&1 || true
$COMPOSE cp "$ROOT/infra/minio-app-policy.json" minio:/tmp/app-policy.json >/dev/null
$COMPOSE exec -T minio mc admin policy create local amr-app-policy /tmp/app-policy.json >/dev/null 2>&1 || true
$COMPOSE exec -T minio mc admin policy attach local amr-app-policy --user amr-app >/dev/null 2>&1 || true

echo "== migrate + provision + _meta + seed =="
pnpm --filter @amr/api --silent run db:migrate
pnpm --filter @amr/tools --silent run provision-bucket
pnpm --filter @amr/tools --silent run gen-meta
pnpm --filter @amr/tools --silent run seed-account

echo "== 启动双 API 实例(M0_TEST_HOOKS=1)=="
( cd "$ROOT/apps/api" && M0_TEST_HOOKS=1 PORT=8300 npx tsx src/main.ts ) & API_PID=$!
( cd "$ROOT/apps/api" && M0_TEST_HOOKS=1 PORT=8301 npx tsx src/main.ts ) & API2_PID=$!
for i in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:8300/api/v1/people -H 'authorization: Bearer x' && break || true
  # 401 也算活;探 TCP
  if curl -s -o /dev/null -w '%{http_code}' http://localhost:8300/api/v1/auth/login -X POST \
       -H 'content-type: application/json' -d '{"email":"x@x.io","password":"x"}' | grep -qE '4..'; then break; fi
  sleep 1
  if [[ $i == 60 ]]; then echo "API 启动超时(探针失败会拒绝启动 —— 查看上方日志)"; exit 1; fi
done
until curl -s -o /dev/null -w '%{http_code}' http://localhost:8301/api/v1/auth/login -X POST \
       -H 'content-type: application/json' -d '{"email":"x@x.io","password":"x"}' | grep -qE '4..'; do sleep 1; done

echo "== A 组验收 =="
( cd "$ROOT/tools" && npx tsx src/m0-acceptance.ts )

echo "== B 组 CI 断言 =="
pnpm --filter @amr/tools --silent run ci:deps
pnpm --filter @amr/storage --silent run test
echo "== M0 验收完成 =="
