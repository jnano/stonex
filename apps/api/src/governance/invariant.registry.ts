import * as fs from 'node:fs';
import * as path from 'node:path';
import { GRANT_WHITELIST, ROLES } from '../../../../db/seeds/permissions';

/** 위반 1건 — SQL 파일의 계약(ri_id, subject, detail)과 1:1 */
export interface Violation {
  ri_id: string;
  subject: string;
  detail: Record<string, unknown>;
}

/** §14.4의 3단계 대응 + 자동 조치 불가한 최상위(호출) */
export type Severity = 'PAGE' | 'L1' | 'L2' | 'L3';

export interface InvariantDef {
  id: string;
  file: string;
  severity: Severity;
  /** 사람이 읽는 한 줄 요약 — 알림 본문에 그대로 실린다 */
  title: string;
}

/**
 * RI별 대응 단계 (작업지시서 WT-34 — v1은 5개 불변식의 대응이 미배정이었다).
 *
 * **자동 조치(L-1)는 RI-3·RI-4 뿐이다.** 나머지는 사람의 판단이 필요하거나(RI-1·RI-6),
 * 자동 삭제가 정상 데이터를 대량으로 지울 위험이 크다(RI-8).
 */
export const INVARIANTS: InvariantDef[] = [
  { id: 'RI-1', file: 'ri-1-active-super-admin.sql', severity: 'PAGE', title: '활성 SUPER_ADMIN 부재 — 시스템 잠금 위험' },
  { id: 'RI-2', file: 'ri-2-self-grant.sql', severity: 'L2', title: '자기 부여 백도어 흔적' },
  { id: 'RI-3', file: 'ri-3-grant-whitelist.sql', severity: 'L1', title: '화이트리스트 밖 ALLOW Grant' },
  { id: 'RI-4', file: 'ri-4-orphan-grants.sql', severity: 'L1', title: '고아 Grant' },
  { id: 'RI-5', file: 'ri-5-tenant-consistency.sql', severity: 'L2', title: '교차 테넌트 누수' },
  { id: 'RI-6', file: 'ri-6-system-roles.sql', severity: 'PAGE', title: '시스템 역할 변조' },
  { id: 'RI-7', file: 'ri-7-audit-hash-chain.sql', severity: 'L3', title: '감사 로그 해시 체인 불일치' },
  { id: 'RI-8', file: 'ri-8-grant-fossils.sql', severity: 'L3', title: '강등된 부여자의 권한 화석' },
  { id: 'RI-9', file: 'ri-9-orphan-module-grants.sql', severity: 'L3', title: '고아 모듈 권한 (미등록 리소스 타입)' },
  { id: 'RI-10', file: 'ri-10-cleanup-backlog.sql', severity: 'L2', title: '소유자 정리 백로그 (퍼지 실패·정체)' },
];

/** SQL 이 검사 대상으로 인정하는 리소스 타입. **여기 없는 타입은 "위반"이 아니라 "검사 불가"다** */
export const KNOWN_RESOURCE_TYPES = Object.keys(GRANT_WHITELIST);

export interface InvariantContext {
  grantWhitelist: Record<string, string[]>;
  knownResourceTypes: string[];
  /** 코드가 실제로 등록한 리소스 타입(레지스트리) — 시드(known)와 어긋나면 RI-9 가 잡는다 */
  registeredResourceTypes: string[];
  systemRoles: string[];
}

/**
 * 불변식 SQL 에 주입할 컨텍스트. **정본은 시드 정의 하나뿐이다**(§15.1) —
 * SQL 안에 화이트리스트나 역할 코드를 하드코딩하면 시드가 바뀔 때 검사만 뒤처진다.
 */
export function buildContext(registeredResourceTypes: string[] = []): InvariantContext {
  return {
    grantWhitelist: GRANT_WHITELIST,
    knownResourceTypes: KNOWN_RESOURCE_TYPES,
    registeredResourceTypes,
    systemRoles: ROLES.filter((r) => r.isSystem).map((r) => r.code),
  };
}

/**
 * 컨텍스트 검증 — **fail-open 차단**.
 *
 * RI-3·RI-4·RI-8 은 컨텍스트가 비면 조용히 0행(=이상 없음)을 반환한다. 화이트리스트 시드가
 * 비거나 로드에 실패한 상황에서 순찰이 "이상 없음"을 보고하면, 감시 장치가 꺼진 것을
 * 아무도 모르게 된다. 그래서 실행 전에 여기서 끊고 "검사 불가"로 드러낸다.
 */
export function assertContextUsable(ctx: InvariantContext): void {
  const types = Object.keys(ctx.grantWhitelist);
  const hasCodes = types.some((t) => (ctx.grantWhitelist[t] ?? []).length > 0);
  if (types.length === 0 || !hasCodes) {
    throw new Error(
      '불변식 검사 불가: Grant 화이트리스트가 비어 있습니다. ' +
        '이 상태로 순찰을 돌리면 RI-3·RI-4가 위반을 0건으로 보고합니다(fail-open).',
    );
  }
  if (ctx.systemRoles.length === 0) {
    throw new Error('불변식 검사 불가: 시스템 역할 정의가 비어 있습니다(RI-6 fail-open).');
  }
  if (ctx.registeredResourceTypes.length === 0) {
    // 레지스트리가 비면 RI-9 가 모든 Grant 를 고아로 보고한다 — 반대 방향의 fail 이지만
    // 원인은 같다(배선 누락). 검사 불가로 끊어 배선 문제를 드러낸다.
    throw new Error('불변식 검사 불가: 리소스 타입 레지스트리가 비어 있습니다(RI-9 오작동).');
  }
}

/** RESOURCE_UNION 치환에 필요한 서술자 부분집합 (ResourceTypeDescriptor 와 구조 호환) */
export interface ResourceTableRef {
  type: string;
  table: string;
  ownerColumn: string;
  tenantColumn: string;
  deletedAtColumn: string;
}

/**
 * 등록된 리소스 타입 전체를 (resource_type, id, owner_id, tenant_id, deleted_at) 로
 * 정규화하는 UNION 조각을 생성한다 (WP-K3).
 *
 * RI-4/5/8 은 리소스 테이블을 조인해야 하는데, 테이블명은 SQL 파라미터로 바인딩할 수 없어
 * 기존에는 `WHEN 'file' THEN … FROM files` 분기가 SQL 에 박혀 있었다 — 신규 타입마다
 * 불변식 SQL 을 고쳐야 하고, 고치지 않으면 그 타입은 **검사 없이 통과**한다(fail-open).
 * 식별자는 레지스트리 등록 시 정규식 검증 + 부팅 시 스키마 대조를 통과한 값만 온다(RT-26).
 */
export function resourceUnionSql(types: ResourceTableRef[]): string {
  if (types.length === 0) {
    // UNION 조각이 비면 SQL 문법 오류가 난다 — 호출 전에 assertContextUsable 이 끊지만,
    // 여기서도 명시적으로 막는다(방어 이중화)
    throw new Error('리소스 타입 레지스트리가 비어 있어 불변식 SQL 을 만들 수 없습니다.');
  }
  return types
    .map(
      (t) =>
        `SELECT '${t.type}' AS resource_type, id, ${t.ownerColumn} AS owner_id, ` +
        `${t.tenantColumn} AS tenant_id, ${t.deletedAtColumn} AS deleted_at FROM ${t.table}`,
    )
    .join('\n  UNION ALL\n  ');
}

/** SQL 본문의 RESOURCE_UNION 플레이스홀더를 레지스트리 생성 조각으로 치환한다 */
export function renderSql(sql: string, types: ResourceTableRef[]): string {
  if (!sql.includes('{{RESOURCE_UNION}}')) return sql;
  return sql.replaceAll('{{RESOURCE_UNION}}', resourceUnionSql(types));
}

const SQL_DIR = path.resolve(__dirname, '../../../../governance/invariants');

/** SQL 본문 로드. 파일이 없으면 조용히 건너뛰지 않고 오류로 드러낸다 */
export function loadSql(def: InvariantDef): string {
  const full = path.join(SQL_DIR, def.file);
  if (!fs.existsSync(full)) {
    throw new Error(`불변식 SQL 파일이 없습니다: ${def.file} (${def.id})`);
  }
  // 파일 끝 세미콜론은 파라미터 바인딩 실행 시 문법 오류가 되므로 제거한다
  return fs.readFileSync(full, 'utf8').trim().replace(/;\s*$/, '');
}
