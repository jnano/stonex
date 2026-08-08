import { PrismaService } from '../../src/prisma/prisma.service';
import { ResourceTypeRegistry } from '../../src/authorization/resource-registry';
import { fileDescriptor } from '../../src/files/file.descriptor';
import { domainDescriptor } from '../../src/domains/domain.descriptor';

/**
 * 테스트용 레지스트리 — app.module 팩토리와 같은 구성(file·domain 서술자).
 * 프로덕션 배선과 다른 등록을 쓰면 테스트가 실제와 다른 게이트를 검증하게 되므로,
 * 서술자 자체를 재사용한다(§15.1 이중 구현 금지).
 *
 * prisma 를 생략하면 load·스키마 대조가 없는 순수 단위용이다 — 상태 게이트 표만 쓰는
 * 평가기 단위 테스트에서 DB 없이 쓸 수 있다.
 */
export function testRegistry(p?: PrismaService): ResourceTypeRegistry {
  const prisma = p ?? (null as unknown as PrismaService);
  const registry = new ResourceTypeRegistry(prisma);
  registry.register(fileDescriptor(prisma));
  registry.register(domainDescriptor(prisma));
  return registry;
}
