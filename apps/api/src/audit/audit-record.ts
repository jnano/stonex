import type { Prisma } from '@stonex/db';

/**
 * 감사 로그 1건의 입력 (기획서 §5.2 audit_logs).
 * actorId=null 은 시스템 행위(가입 시 자동 역할 부여 등)를 뜻한다.
 * detail 에는 변경 전/후 값을 { before, after } 형태로 담는 것을 표준으로 한다.
 */
export interface AuditEntry {
  tenantId: string;
  actorId: string | null;
  action: string; // 예: 'role.grant', 'member.ban'
  targetType?: string;
  targetId?: string;
  detail?: { before?: unknown; after?: unknown } & Record<string, unknown>;
  ipAddress?: string;
}

/**
 * 권한 변경 행위의 감사 기록 (INV-6 구현 프리미티브 — WP-6a).
 *
 * 반드시 변경 행위와 **동일한 트랜잭션 클라이언트(tx)** 로 호출해야 한다.
 * 이 함수가 던지는 예외를 잡아 무시하는 것을 금지한다 — 예외 전파로 트랜잭션이
 * 롤백되는 것이 "기록 실패 시 변경 자체를 롤백한다"의 구현이다.
 * (audit_logs 는 Prisma 모델이 없는 파티션 테이블이라 raw SQL 로 기록한다 — db/README.md R-1)
 *
 * 사용 예:
 *   await prisma.$transaction(async (tx) => {
 *     await tx.userRole.create({ ... });                 // 변경
 *     await recordAudit(tx, { action: 'role.grant', ... }); // 기록 (실패 시 전체 롤백)
 *   });
 */
/**
 * 감사 detail 에 **절대 들어가면 안 되는 키** (WT-26).
 *
 * 마스킹이 아니라 **기록 자체를 막는다** — 마스킹은 "저장은 했지만 가렸다"이므로
 * 백업·복제본·디버그 덤프에는 그대로 남는다. 감사 로그는 보존 기간이 길고 조회 권한이
 * 넓어(§6.5 ADM-4) 한 번 들어간 비밀은 회수할 방법이 사실상 없다.
 */
const FORBIDDEN_KEYS = new Set([
  'password', 'passwordHash', 'password_hash',
  'totpSecret', 'totp_secret',
  'verifyToken', 'verify_token',
  'storageKey', 'storage_key',
  'refreshToken', 'refresh_token', 'accessToken', 'access_token',
  'secret', 'keyUri',
]);

/** 중첩 객체까지 훑어 금지 키를 제거한다. 배열 안의 객체도 대상이다 */
function stripForbidden(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripForbidden(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) continue; // 값을 가리지 않고 키째 버린다
    out[key] = stripForbidden(v, depth + 1);
  }
  return out;
}

export async function recordAudit(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit.audit_logs (tenant_id, actor_id, action, target_type, target_id, detail, ip_address)
    VALUES (
      ${entry.tenantId}::uuid,
      ${entry.actorId}::uuid,
      ${entry.action},
      ${entry.targetType ?? null},
      ${entry.targetId ?? null}::uuid,
      ${JSON.stringify(stripForbidden(entry.detail ?? {}))}::jsonb,
      ${entry.ipAddress ?? null}::inet
    )`;
}
