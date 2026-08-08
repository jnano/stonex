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
  // RI-9 는 WP-K3(고아 모듈 권한)에 예약되어 있다 — 번호가 순서를 건너뛰는 이유
  { id: 'RI-10', file: 'ri-10-cleanup-backlog.sql', severity: 'L2', title: '소유자 정리 백로그 (퍼지 실패·정체)' },
];

/** SQL 이 검사 대상으로 인정하는 리소스 타입. **여기 없는 타입은 "위반"이 아니라 "검사 불가"다** */
export const KNOWN_RESOURCE_TYPES = Object.keys(GRANT_WHITELIST);

export interface InvariantContext {
  grantWhitelist: Record<string, string[]>;
  knownResourceTypes: string[];
  systemRoles: string[];
}

/**
 * 불변식 SQL 에 주입할 컨텍스트. **정본은 시드 정의 하나뿐이다**(§15.1) —
 * SQL 안에 화이트리스트나 역할 코드를 하드코딩하면 시드가 바뀔 때 검사만 뒤처진다.
 */
export function buildContext(): InvariantContext {
  return {
    grantWhitelist: GRANT_WHITELIST,
    knownResourceTypes: KNOWN_RESOURCE_TYPES,
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
