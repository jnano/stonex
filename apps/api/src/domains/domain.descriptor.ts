import { PrismaService } from '../prisma/prisma.service';
import { ResourceTypeDescriptor } from '../authorization/resource-registry';

/**
 * domain 리소스 서술자 (WP-K1).
 *
 * readExtra: SUSPENDED 도메인도 조회 Permission 에 한해 보인다 — 소유자가 정지 사유를
 * 확인할 수 있어야 하기 때문(§4.7). 이 예외가 상태 게이트를 서술자로 옮긴 이유이기도 하다:
 * 커널 상수에 남겨 두면 타입마다 커널을 고치게 된다.
 */
export const domainDescriptor = (prisma: PrismaService): ResourceTypeDescriptor => ({
  type: 'domain',
  table: 'domains',
  ownerColumn: 'owner_id',
  deletedAtColumn: 'deleted_at',
  tenantColumn: 'tenant_id',
  statusColumn: 'status',
  stateGate: {
    accessible: ['UNVERIFIED', 'VERIFIED'],
    readExtra: { statuses: ['SUSPENDED'], permissions: ['domain.read', 'domain.read.all'] },
  },
  load: async (id) => {
    const d = await prisma.domain.findUnique({ where: { id } });
    if (!d) return null;
    return { id: d.id, ownerId: d.owner_id, status: d.status, tenantId: d.tenant_id, deletedAt: d.deleted_at };
  },
});
