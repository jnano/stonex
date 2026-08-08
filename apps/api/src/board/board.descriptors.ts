import { PrismaService } from '../prisma/prisma.service';
import { ResourceTypeDescriptor } from '../authorization/resource-registry';

/**
 * board 모듈 리소스 서술자 3종 (WP-B1) — §9.1 표준 확장 경로의 첫 신규 사용자.
 *
 * 커널 코드는 0줄 변경 없이, 이 서술자 등록만으로 로더·평가기 상태 게이트·Grant 잠금·
 * 불변식(RESOURCE_UNION)에 편입된다 — 트랙 A(WP-K1~K3)가 만든 경로의 실증이다.
 */

/**
 * 게시판은 **회원 소유가 아니다**(스펙 §3.3 — 관리자가 생성, 접근은 가시성 정책).
 * 따라서 owner 는 생성 관리자를 가리키되, **소유자 삭제 은닉(ownerDeletedAt)은 걸지
 * 않는다** — 생성 관리자가 탈퇴해도 게시판은 살아 있어야 한다. RESOURCE_UNION 의
 * owner_deleted 판정(RI-4 자동 회수)에 걸리지 않도록 ownerColumn 도 자기 id 로 둔다.
 */
export const boardDescriptor = (prisma: PrismaService): ResourceTypeDescriptor => ({
  type: 'board',
  table: 'boards',
  ownerColumn: 'id', // 소유 개념 없음 — owner_id = 자기 자신(항상 존재·비삭제 판정과 무관)
  deletedAtColumn: 'deleted_at',
  tenantColumn: 'tenant_id',
  statusColumn: 'status',
  // ARCHIVED 는 읽기 전용 보존 상태 — 조회·관리 Permission 에 한해 접근 허용
  // (board.manage 가 없으면 ARCHIVED → ACTIVE 복원이 1단계에서 막힌다)
  stateGate: {
    accessible: ['ACTIVE'],
    readExtra: { statuses: ['ARCHIVED'], permissions: ['board.read', 'board.moderate.all', 'board.manage'] },
  },
  load: async (id) => {
    const b = await prisma.board.findUnique({ where: { id } });
    if (!b) return null;
    return {
      id: b.id, ownerId: b.id, status: b.status, tenantId: b.tenant_id,
      deletedAt: b.deleted_at, ownerDeletedAt: null,
    };
  },
});

/** 게시글 — 작성자 소유(owned scope 판정 기준). HIDDEN(운영 숨김)은 작성자도 수정 불가 */
export const postDescriptor = (prisma: PrismaService): ResourceTypeDescriptor => ({
  type: 'post',
  table: 'posts',
  ownerColumn: 'owner_id',
  deletedAtColumn: 'deleted_at',
  tenantColumn: 'tenant_id',
  statusColumn: 'status',
  stateGate: { accessible: ['DRAFT', 'PUBLISHED'] },
  load: async (id) => {
    const p = await prisma.post.findUnique({ where: { id } });
    if (!p) return null;
    const owner = await prisma.user.findUnique({ where: { id: p.owner_id }, select: { deleted_at: true } });
    return {
      id: p.id, ownerId: p.owner_id, status: p.status, tenantId: p.tenant_id,
      deletedAt: p.deleted_at, ownerDeletedAt: owner?.deleted_at ?? null,
    };
  },
});

export const commentDescriptor = (prisma: PrismaService): ResourceTypeDescriptor => ({
  type: 'comment',
  table: 'comments',
  ownerColumn: 'owner_id',
  deletedAtColumn: 'deleted_at',
  tenantColumn: 'tenant_id',
  statusColumn: 'status',
  stateGate: { accessible: ['PUBLISHED'] },
  load: async (id) => {
    const c = await prisma.comment.findUnique({ where: { id } });
    if (!c) return null;
    const owner = await prisma.user.findUnique({ where: { id: c.owner_id }, select: { deleted_at: true } });
    return {
      id: c.id, ownerId: c.owner_id, status: c.status, tenantId: c.tenant_id,
      deletedAt: c.deleted_at, ownerDeletedAt: owner?.deleted_at ?? null,
    };
  },
});
