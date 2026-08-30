#!/usr/bin/env bash
# P0-P4 required core gate。显式无 provider、无 worker，不读取 AI fixtures/cassettes。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN_SUFFIX="$(date +%s)-$$"
COMPOSE_PROJECT="amr-core-$RUN_SUFFIX"
COMPOSE="docker compose -p $COMPOSE_PROJECT -f $ROOT/infra/docker-compose.yml -f $ROOT/infra/docker-compose.m2-acceptance.yml"
export AUTH_SECRET="core-acceptance-secret-0123456789abcdef"
export S3_BUCKET="medical-record"
export REPO_ROOT="$ROOT"
export SEED_EMAIL="owner@local.test"
export SEED_PASSWORD="core-acceptance-password"
export PROCESSING_MODE="off"
export EXPORT_MAX_ORIGINAL_BYTES="500"
export CORE_BUNDLE_PATH="/tmp/amr-core-$RUN_SUFFIX-bundle.zip"
unset AI_PROVIDER AI_MODEL ANTHROPIC_API_KEY DEEPSEEK_API_KEY AMR_AI_CASSETTE_DIR AMR_AI_RECORD

cleanup() {
  for pid in "${API_PID:-}" "${EXPORT_PID:-}" "${WEB_PID:-}"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  $COMPOSE down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== Core acceptance: isolated PostgreSQL + MinIO =="
API_PORT="$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
WEB_PORT="$(node -e "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
export API_URL="http://localhost:$API_PORT"
export WEB_URL="http://localhost:$WEB_PORT"
export WEB_ORIGIN="$WEB_URL"
$COMPOSE up -d --wait
PG_PORT="$($COMPOSE port postgres 5432 | awk -F: '{print $NF}')"
S3_PORT="$($COMPOSE port minio 9000 | awk -F: '{print $NF}')"
export DATABASE_URL="postgres://amr:amr@localhost:$PG_PORT/amr"
export S3_ENDPOINT="http://localhost:$S3_PORT"

pnpm -r --filter './packages/**' --silent run build

$COMPOSE exec -T minio mc alias set local http://localhost:9000 amr-admin amr-admin-secret >/dev/null
$COMPOSE exec -T minio mc admin user add local amr-app amr-app-secret >/dev/null 2>&1 || true
$COMPOSE cp "$ROOT/infra/minio-app-policy.json" minio:/tmp/app-policy.json >/dev/null
$COMPOSE exec -T minio mc admin policy create local amr-app-policy /tmp/app-policy.json >/dev/null 2>&1 || true
$COMPOSE exec -T minio mc admin policy attach local amr-app-policy --user amr-app >/dev/null 2>&1 || true

pnpm --filter @amr/api --silent run db:migrate
pnpm --filter @amr/tools --silent run provision-bucket
pnpm --filter @amr/tools --silent run gen-meta
pnpm --filter @amr/tools --silent run seed-account

echo "== 启动 Core API、确定性导出 worker 与 Web（PROCESSING_MODE=off）=="
( cd "$ROOT/apps/api" && exec env PROCESSING_MODE=off PORT="$API_PORT" \
    node --import ./node_modules/tsx/dist/loader.mjs src/main.ts ) & API_PID=$!
( cd "$ROOT/apps/api" && exec env PROCESSING_MODE=off \
    node --import ./node_modules/tsx/dist/loader.mjs src/export-main.ts ) & EXPORT_PID=$!
( cd "$ROOT/apps/web" && VITE_API_BASE="$API_URL" VITE_M1_TEST_HOOKS=1 npx vite build >/dev/null \
    && exec npx vite preview --host 127.0.0.1 --port "$WEB_PORT" --strictPort ) & WEB_PID=$!

for i in $(seq 1 90); do
  api_status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/v1/auth/login" \
    -H 'content-type: application/json' -d '{"email":"x@x.io","password":"xxxxxxxx"}' || echo 000)"
  web_status="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/" || echo 000)"
  if [[ "$api_status" =~ ^4 ]] && [[ "$web_status" == "200" ]]; then break; fi
  sleep 1
  if [[ $i == 90 ]]; then echo "Core 服务启动超时 api=$api_status web=$web_status"; exit 1; fi
done

echo "== Core-0 assertions =="
pnpm --filter @amr/tools --silent run core:acceptance
pnpm --filter @amr/tools --silent run p0-web:acceptance
# 导出 E2E 已完成；删 schema 前有序停止 worker，避免把预期中的重建窗口
# 误报成 worker 崩溃。重建本身只恢复 L1，export job/工件按设计属于可删除 L2。
kill "$EXPORT_PID" 2>/dev/null || true
wait "$EXPORT_PID" 2>/dev/null || true
EXPORT_PID=""
unzip -t "$CORE_BUNDLE_PATH" >/dev/null
BUNDLE_ENTRIES="$(zipinfo -1 "$CORE_BUNDLE_PATH")"
if ! grep -qx 'bundle-manifest.json' <<<"$BUNDLE_ENTRIES"; then
  echo "P0 bundle 缺 bundle-manifest.json"
  exit 1
fi
if grep -Eq '^(derived/|_incoming/|_probe/)' <<<"$BUNDLE_ENTRIES"; then
  echo "P0 bundle 泄漏 L2/暂存对象"
  exit 1
fi
echo "P0 bundle ZIP 完整性与 L1 边界通过"

echo "== P0/P1/P2/P3/P4-facts L1 delete/rebuild equivalence =="
CORE_SNAPSHOT="/tmp/amr-core-$RUN_SUFFIX-snapshot.json"
pnpm --filter @amr/tools --silent exec tsx src/verify-rebuild.ts --dump "$CORE_SNAPSHOT"
$COMPOSE exec -T postgres psql -U amr -d amr -q -c \
  'drop schema public cascade; create schema public; drop schema if exists drizzle cascade;'
pnpm --filter @amr/api --silent run db:migrate
FIRST_REBUILD="$(pnpm --filter @amr/tools --silent run rebuild-index)"
echo "$FIRST_REBUILD"
pnpm --filter @amr/tools --silent exec tsx src/verify-rebuild.ts --compare "$CORE_SNAPSHOT"
SECOND_REBUILD="$(pnpm --filter @amr/tools --silent run rebuild-index)"
echo "$SECOND_REBUILD"
pnpm --filter @amr/tools --silent exec tsx src/verify-rebuild.ts --compare "$CORE_SNAPSHOT"
REBUILD_COUNTS="$($COMPOSE exec -T postgres psql -U amr -d amr -Atc \
  "select (select count(*) from search_entry),(select count(*) from context_session),(select count(*) from context_answer),(select count(*) from context_upload),(select count(*) from observation),(select count(*) from concept_alias_decision),(select count(*) from metric_group),(select count(*) from metric_group_item),(select count(*) from medication),(select count(*) from timeline_event),(select count(*) from processing_job),(select count(*) from processing_suggestion)")"
if [[ "$REBUILD_COUNTS" != "39|4|16|2|16|1|3|14|5|4|0|0" ]]; then
  echo "P0/P1/P2/P3/P4-facts 重建后的事实与 L2 投影不符合预期: $REBUILD_COUNTS"
  exit 1
fi
echo "P0/P1/P2/P3/P4-facts 重建验收通过(search=39, context=4/16/2, observation=16（含 context 显式提升、浏览器人工事实与确定性派生）, alias=1, metric group/item=3/14, medication/timeline=5/4, processing job/suggestion=0)"

pnpm --silent run ci:deps
pnpm --filter @amr/contracts --silent run test
pnpm --filter @amr/api --silent run test
pnpm --filter @amr/web --silent run test
echo "== Core acceptance passed =="
