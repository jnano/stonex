#!/usr/bin/env bash
# break-glass 절차 모의 실행 (docs/.../break-glass-runbook-v1.md §6)
#
# 런북의 §4.1~4.6 을 스테이징 상당 DB에서 그대로 수행하고 결과를 검증한다.
# "절차가 실제로 동작하지 않는 런북은 없는 것과 같다" — 분기 1회 실행 권장.
#
# 사용: DRILL_DATABASE_URL=postgresql://... ./scripts/breakglass-drill.sh
# 주의: 운영 DB에서 실행 금지. 스크립트가 자체 생성한 테스트 계정만 다루고 종료 시 정리한다.
set -euo pipefail

DB_URL="${DRILL_DATABASE_URL:-${TEST_DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "DRILL_DATABASE_URL 또는 TEST_DATABASE_URL 이 필요합니다." >&2
  exit 1
fi
case "$DB_URL" in
  *prod*|*production*) echo "운영 DB로 보이는 접속 문자열입니다. 중단합니다." >&2; exit 1 ;;
esac

TENANT="00000000-0000-0000-0000-000000000000"
TARGET_EMAIL="drill-target-$$@breakglass.local"
BG_ACTOR="${BG_ACTOR:-drill-runner}"
BG_WITNESS="${BG_WITNESS:-drill-witness}"

psql_q() { psql "$DB_URL" -v ON_ERROR_STOP=1 -qtA -c "$1"; }

cleanup() {
  psql_q "DELETE FROM audit.audit_logs WHERE detail->>'drill' = '$$'" >/dev/null 2>&1 || true
  psql_q "DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = '$TARGET_EMAIL')" >/dev/null 2>&1 || true
  psql_q "DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email = '$TARGET_EMAIL')" >/dev/null 2>&1 || true
  psql_q "DELETE FROM users WHERE email = '$TARGET_EMAIL'" >/dev/null 2>&1 || true
  psql_q "ALTER ROLE stonex_breakglass NOLOGIN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "▶ 0) 준비 — 대상 SUPER_ADMIN 계정 생성"
psql_q "INSERT INTO users (tenant_id, email, password_hash, name, status)
        VALUES ('$TENANT', '$TARGET_EMAIL', 'x', 'drill 대상', 'ACTIVE')" >/dev/null
psql_q "INSERT INTO user_roles (tenant_id, user_id, role_id)
        SELECT '$TENANT', u.id, r.id FROM users u, roles r
        WHERE u.email = '$TARGET_EMAIL' AND r.code = 'SUPER_ADMIN' AND r.tenant_id = '$TENANT'" >/dev/null
psql_q "INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
        SELECT id, md5(random()::text), gen_random_uuid(), now() + interval '14 days'
        FROM users WHERE email = '$TARGET_EMAIL'" >/dev/null

echo "▶ 1) 전용 계정 활성화 (§4.1)"
psql_q "DO \$\$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='stonex_breakglass') THEN
            CREATE ROLE stonex_breakglass NOLOGIN;
          END IF;
        END \$\$" >/dev/null
psql_q "ALTER ROLE stonex_breakglass LOGIN PASSWORD 'drill-only-$$'" >/dev/null

echo "▶ 2~3) 조치 전 기록 + 정지·역할 회수·토큰 폐기 (§4.2~4.3)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO audit.audit_logs (tenant_id, actor_id, action, target_type, target_id, detail)
SELECT u.tenant_id, NULL, 'breakglass.begin', 'user', u.id,
       jsonb_build_object('drill', '$$', 'actor', '$BG_ACTOR', 'witness', '$BG_WITNESS',
                          'before', jsonb_build_object('status', u.status))
FROM users u WHERE u.email = '$TARGET_EMAIL';

UPDATE users SET status = 'SUSPENDED', perm_version = perm_version + 1 WHERE email = '$TARGET_EMAIL';

DELETE FROM user_roles ur USING users u, roles r
WHERE ur.user_id = u.id AND ur.role_id = r.id
  AND u.email = '$TARGET_EMAIL' AND r.code = 'SUPER_ADMIN';

UPDATE refresh_tokens SET revoked_at = now()
WHERE user_id = (SELECT id FROM users WHERE email = '$TARGET_EMAIL') AND revoked_at IS NULL;

INSERT INTO audit.audit_logs (tenant_id, actor_id, action, target_type, target_id, detail)
SELECT u.tenant_id, NULL, 'breakglass.end', 'user', u.id,
       jsonb_build_object('drill', '$$', 'actor', '$BG_ACTOR', 'witness', '$BG_WITNESS',
                          'after', jsonb_build_object('status', u.status, 'super_admin_revoked', true))
FROM users u WHERE u.email = '$TARGET_EMAIL';
COMMIT;
SQL

echo "▶ 4) 불변식 확인 (RI-1: 활성 SUPER_ADMIN ≥ 1)"
REMAINING=$(psql_q "SELECT count(*) FROM users u
  JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
  WHERE r.code='SUPER_ADMIN' AND u.status='ACTIVE' AND (ur.expires_at IS NULL OR ur.expires_at > now())")
echo "   남은 활성 SUPER_ADMIN: $REMAINING"
[ "$REMAINING" -ge 1 ] || { echo "   ✗ RI-1 위반 — 실제 상황이라면 §4.5 선행 필요"; exit 1; }

echo "▶ 5) 검증"
STATUS=$(psql_q "SELECT status FROM users WHERE email = '$TARGET_EMAIL'")
ROLES=$(psql_q "SELECT count(*) FROM user_roles ur JOIN users u ON u.id=ur.user_id WHERE u.email='$TARGET_EMAIL'")
ALIVE=$(psql_q "SELECT count(*) FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
                WHERE u.email='$TARGET_EMAIL' AND rt.revoked_at IS NULL")
LOGS=$(psql_q "SELECT count(*) FROM audit.audit_logs WHERE detail->>'drill' = '$$'")
[ "$STATUS" = "SUSPENDED" ] || { echo "   ✗ 대상 계정이 정지되지 않음: $STATUS"; exit 1; }
[ "$ROLES" -eq 0 ] || { echo "   ✗ 역할이 회수되지 않음: $ROLES"; exit 1; }
[ "$ALIVE" -eq 0 ] || { echo "   ✗ 유효 리프레시 토큰 잔존: $ALIVE"; exit 1; }
[ "$LOGS" -eq 2 ] || { echo "   ✗ 감사 로그 2건이 아님: $LOGS"; exit 1; }
echo "   ✓ 정지·역할 회수·토큰 폐기·감사 로그 2건 확인"

echo "▶ 6) 전용 계정 재비활성화 (§4.6)"
psql_q "ALTER ROLE stonex_breakglass NOLOGIN" >/dev/null
CANLOGIN=$(psql_q "SELECT rolcanlogin FROM pg_roles WHERE rolname='stonex_breakglass'")
[ "$CANLOGIN" = "f" ] || { echo "   ✗ 전용 계정이 여전히 로그인 가능"; exit 1; }
echo "   ✓ 전용 계정 비활성 확인"

echo
echo "✅ break-glass 모의 실행 성공 — 런북 §4.1~4.6 전 절차 검증 완료"
