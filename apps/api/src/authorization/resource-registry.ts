import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 리소스 타입 레지스트리 (Phase 3 WP-K1, 계획서 MC-5).
 *
 * 커널이 리소스 타입을 **코드 분기 없이 데이터로만** 알게 하는 단일 지점.
 * 기존에는 file·domain 이 커널 3곳(평가기 상태 게이트·리소스 로더·Grant 잠금 테이블 분기)에
 * 문자열로 박혀 있어, 신규 타입을 붙이면 커널을 고쳐야 했고 — 특히
 * `resourceType === 'file' ? 'files' : 'domains'` 는 세 번째 타입이 오면
 * **엉뚱한 테이블을 잠그는** 잠복 결함이었다(검토 RT-23 실측).
 *
 * 신규 리소스 타입은 서술자 하나를 여기 등록하는 것으로 편입된다(§9.1).
 * 커널은 등록된 것만 알고, 등록되지 않은 타입은 존재하지 않는 것으로 취급한다(404 정규화).
 */

/** 평가기 §4.7 1단계 상태 게이트 — 타입별 "접근 가능 상태" 집합 */
export interface ResourceStateGate {
  accessible: readonly string[];
  /** 해당 Permission 에 한해 추가 허용되는 상태 (예: 도메인 조회의 SUSPENDED) */
  readExtra?: { statuses: readonly string[]; permissions: readonly string[] };
}

/** 서술자의 load 가 돌려주는 행 — deleted 판정은 커널이 일괄 수행한다(WT-25 참조) */
export interface LoadedResourceRow {
  id: string;
  ownerId: string;
  status: string;
  tenantId: string;
  deletedAt: Date | null;
}

export interface ResourceTypeDescriptor {
  /** 리소스 타입 식별자 — Grant resource_type·Permission 접두어·라우트가 공유 */
  type: string;
  /** 실제 테이블명 — Grant 생성 시 FOR UPDATE 잠금 대상. SQL 에 들어가므로 등록 시 검증된다 */
  table: string;
  ownerColumn: string;
  deletedAtColumn: string;
  tenantColumn: string;
  statusColumn: string;
  stateGate: ResourceStateGate;
  /**
   * 리소스 1행 로드. 소프트 삭제 행도 **그대로 돌려준다** — 삭제 판정(deletedAt)은
   * 커널이 일괄 수행한다. 각 서술자가 삭제 검사를 직접 하게 두면 하나가 빠뜨렸을 때
   * 삭제 리소스가 게이트를 통과하는 구멍이 된다(WT-25 가 실제 그 사례였다).
   */
  load: (id: string) => Promise<LoadedResourceRow | null>;
}

/**
 * 서술자의 table·컬럼명은 신뢰 경계다 — Grant 잠금 SQL 과 불변식 SQL 에 들어간다.
 * 정규식은 "형식이 식별자다"만 보증하므로, 실제 스키마 대조(onModuleInit)와 이중으로 검증한다(RT-26).
 */
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

@Injectable()
export class ResourceTypeRegistry implements OnModuleInit {
  private readonly types = new Map<string, ResourceTypeDescriptor>();

  constructor(private readonly prisma: PrismaService) {}

  register(descriptor: ResourceTypeDescriptor): void {
    const identifiers: Array<[string, string]> = [
      ['type', descriptor.type],
      ['table', descriptor.table],
      ['ownerColumn', descriptor.ownerColumn],
      ['deletedAtColumn', descriptor.deletedAtColumn],
      ['tenantColumn', descriptor.tenantColumn],
      ['statusColumn', descriptor.statusColumn],
    ];
    for (const [field, value] of identifiers) {
      if (!IDENTIFIER_RE.test(value)) {
        throw new Error(`리소스 서술자 ${field} 가 식별자 형식이 아닙니다: "${value}"`);
      }
    }
    if (this.types.has(descriptor.type)) {
      // 나중 등록이 조용히 이기면 어느 서술자가 유효한지 코드만 봐서는 알 수 없게 된다
      throw new Error(`리소스 타입이 중복 등록되었습니다: ${descriptor.type}`);
    }
    this.types.set(descriptor.type, descriptor);
  }

  get(type: string): ResourceTypeDescriptor | undefined {
    return this.types.get(type);
  }

  all(): ResourceTypeDescriptor[] {
    return [...this.types.values()];
  }

  /**
   * 특정 Permission 으로 접근 가능한 리소스 상태 집합 (§4.7 1단계의 목록 대응물).
   * 목록 API 는 1단계 게이트를 쿼리 조건으로 다시 써야 하는데, 손으로 옮겨 적으면
   * §15.1 이중 구현이 된다 — 특히 도메인은 readExtra 때문에 틀리기 쉽다.
   */
  statusesAllowing(resourceType: string, permission: string): readonly string[] {
    const gate = this.types.get(resourceType)?.stateGate;
    if (!gate) return [];
    const extra =
      gate.readExtra && gate.readExtra.permissions.includes(permission) ? gate.readExtra.statuses : [];
    return [...gate.accessible, ...extra];
  }

  /**
   * 부팅 시 서술자를 실제 마이그레이션된 스키마와 대조한다 (RT-26).
   *
   * 정규식은 오타·존재하지 않는 테이블을 잡지 못한다. 버그 있는 서술자는 SQL 주입이 아니라
   * **횡단 불변식(RI-4/5/8)의 조용한 오작동**이 위협이다 — 안전망의 정의가 틀린 문자열에
   * 종속되는 것. 불일치는 저장할 값이 아니라 부팅을 막을 결함이므로 여기서 즉시 실패한다.
   */
  async onModuleInit(): Promise<void> {
    for (const d of this.all()) {
      const columns = await this.prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${d.table}`;
      if (columns.length === 0) {
        throw new Error(`리소스 서술자 검증 실패 — 테이블이 존재하지 않습니다: ${d.type} → ${d.table}`);
      }
      const present = new Set(columns.map((c) => c.column_name));
      const required = ['id', d.ownerColumn, d.deletedAtColumn, d.tenantColumn, d.statusColumn];
      const missing = required.filter((c) => !present.has(c));
      if (missing.length > 0) {
        throw new Error(
          `리소스 서술자 검증 실패 — ${d.table} 에 선언된 컬럼이 없습니다: ${missing.join(', ')}`,
        );
      }
    }
  }
}
