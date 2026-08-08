#!/usr/bin/env bash
# G-6-lite 커널 보호 파일 게이트 (Phase 3 작업지시서 v3 §1.3, 검토 RT-35).
#
# "§9.1 커널 0줄 편입"의 검증 가능한 정의: 아래 목록의 diff 가 0 이어야 한다.
# 확장 지점(app.module·app.controllers·시드·골든)의 diff 는 허용된다.
#
# 의도된 커널 변경(트랙 A 의 K2·K3 등)은 PR 에 `kernel-change` 라벨을 달아 통과시킨다 —
# 라벨 부여가 곧 명시적 승인 기록이다. 라벨 판정은 CI 워크플로가 하고,
# 이 스크립트는 SKIP_G6=1 이면 그 사실만 알리고 통과한다.
set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"

PROTECTED=(
  "apps/api/src/authorization/authorization.service.ts"
  "apps/api/src/authorization/dominance.ts"
  "apps/api/src/authorization/policy.service.ts"
  "apps/api/src/authorization/guards"
  "apps/api/src/authorization/resource-grant.service.ts"
  "apps/api/src/authorization/resource-loader.ts"
  "apps/api/src/authorization/resource-registry.ts"
  "governance/invariants"
)

if [[ "${SKIP_G6:-}" == "1" ]]; then
  echo "G-6-lite 건너뜀: kernel-change 라벨로 커널 변경이 명시 승인됨"
  exit 0
fi

git fetch --quiet origin main 2>/dev/null || true
# mapfile 은 bash 4+ 전용이라 macOS 기본 bash(3.2)에서 죽는다 — 문자열로 받는다
changed="$(git diff --name-only "${BASE_REF}"...HEAD -- "${PROTECTED[@]}")"

if [[ -n "${changed}" ]]; then
  echo "G-6-lite 실패 — 보호된 커널 파일이 변경되었습니다 (§1.3):"
  echo "${changed}" | sed 's/^/  - /'
  echo ""
  echo "의도된 커널 변경이면 PR 에 'kernel-change' 라벨을 달아 명시 승인하십시오."
  exit 1
fi

echo "G-6-lite 통과: 보호 커널 파일 diff 0 (기준: ${BASE_REF})"
