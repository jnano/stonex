import { PrismaService } from '../prisma/prisma.service';
import { ResourceTypeDescriptor } from '../authorization/resource-registry';

/**
 * file 리소스 서술자 (WP-K1).
 *
 * 기존에 커널 3곳에 흩어져 있던 file 지식(상태 게이트·로더·잠금 테이블)을 한 곳으로 모았다.
 * 코드는 커널에 남되 결합만 끊는다 — 폴더 추출은 트랙 B(D-3 조건 발동 시).
 */
export const fileDescriptor = (prisma: PrismaService): ResourceTypeDescriptor => ({
  type: 'file',
  table: 'files',
  ownerColumn: 'owner_id',
  deletedAtColumn: 'deleted_at',
  tenantColumn: 'tenant_id',
  statusColumn: 'status',
  stateGate: { accessible: ['ACTIVE'] },
  load: async (id) => {
    const f = await prisma.file.findUnique({ where: { id }, include: { owner: { select: { deleted_at: true } } } });
    if (!f) return null;
    return {
      id: f.id, ownerId: f.owner_id, status: f.status, tenantId: f.tenant_id,
      deletedAt: f.deleted_at, ownerDeletedAt: f.owner.deleted_at,
    };
  },
});
