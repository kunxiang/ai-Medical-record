#!/usr/bin/env bash
# M2 自动验收入口。当前把既有全仓门禁与 A33–A35 恢复演练固定为可重复执行流程。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_SUFFIX="$(date +%s)-$$"
export AMR_M2_COMPOSE_PROJECT="amr-m2-$RUN_SUFFIX"
export AMR_M2_COMPOSE_OVERRIDE="$ROOT/infra/docker-compose.m2-acceptance.yml"
COMPOSE="docker compose -p $AMR_M2_COMPOSE_PROJECT -f $ROOT/infra/docker-compose.yml -f $AMR_M2_COMPOSE_OVERRIDE"
M2_TEMP_DIR="$(mktemp -d /tmp/amr-m2.XXXXXX)"
export AUTH_SECRET="m2-acceptance-secret-0123456789abcdef"
export S3_BUCKET="medical-record"
export REPO_ROOT="$ROOT"
export WEB_ORIGIN="http://localhost:5173"
export AMR_M2_TMP_DIR="$M2_TEMP_DIR"
export AMR_AI_CALL_LOG="$M2_TEMP_DIR/ai-calls.jsonl"
touch "$AMR_AI_CALL_LOG"
export AI_PROVIDER="anthropic"
export AI_MODEL="claude-opus-5"
export AMR_AI_CASSETTE_DIR="$ROOT/fixtures/m2/cassettes"
export AMR_AI_RECORD="0"

cleanup() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP:-}" != "--keep" ]]; then $COMPOSE down -v >/dev/null 2>&1 || true; fi
  [[ -n "${M2_TEMP_DIR:-}" ]] && rm -rf "$M2_TEMP_DIR"
}
trap cleanup EXIT
KEEP="${1:-}"

echo "== M2 候选验收（synthetic cassette 场景；真实 wire 录制盒仍是正式验收门槛）=="
echo "== M2 清场与基础服务 =="
$COMPOSE down -v >/dev/null 2>&1 || true
$COMPOSE up -d --wait
PG_PORT="$($COMPOSE port postgres 5432 | awk -F: '{print $NF}')"
S3_PORT="$($COMPOSE port minio 9000 | awk -F: '{print $NF}')"
API_PORT="$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
export DATABASE_URL="postgres://amr:amr@localhost:$PG_PORT/amr"
export S3_ENDPOINT="http://localhost:$S3_PORT"
export API_URL="http://localhost:$API_PORT"

echo "== 构建 workspace packages（API 的 workspace imports 必须使用本轮源码）=="
pnpm -r --filter './packages/**' --silent run build

echo "== MinIO 应用用户与策略 =="
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

echo "== 启动 API（不启动 worker，恢复演练不得调用 AI）=="
( cd "$ROOT/apps/api" && exec env AI_JOB_WORKER=0 PORT="$API_PORT" \
    node --import ./node_modules/tsx/dist/loader.mjs src/main.ts ) & API_PID=$!
for i in $(seq 1 60); do
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/v1/auth/login" \
    -H 'content-type: application/json' -d '{"email":"x@x.io","password":"xxxxxxxx"}' || echo 000)
  [[ "$status" =~ ^4 ]] && break
  sleep 1
  if [[ $i == 60 ]]; then echo "API 启动超时 status=$status"; exit 1; fi
done

echo "== A33–A35 人工层恢复演练 =="
pnpm --filter @amr/tools --silent run m2:acceptance

echo "== B 组代码与契约门禁 =="
pnpm --filter @amr/tools --silent run ci:deps
pnpm --filter @amr/tools --silent run scan-m2-pii
pnpm --filter @amr/tools --silent run test
pnpm --filter @amr/contracts --silent run test
pnpm --filter @amr/storage --silent run test
pnpm --filter @amr/ai --silent run test
pnpm --filter @amr/api --silent run test
pnpm typecheck

echo "== M2 候选自动验收完成（不等同于真实 wire cassette 已验收）=="
