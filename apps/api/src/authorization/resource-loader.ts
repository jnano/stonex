import { Injectable, NotFoundException } from '@nestjs/common';
import { ResourceTypeRegistry } from './resource-registry';
import { ResourceRef } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 리소스 1회 로드 (§4.7): 리소스형 API는 Guard 단계에서 로드하여
 * 평가기와 핸들러가 공유한다(이중 조회 방지). request.resource 로 전달.
 * 신규 리소스 타입은 서술자 등록만으로 편입된다(§9.1, WP-K1) — 이 파일은 더 이상
 * 타입 이름을 모른다.
 */
@Injectable()
export class ResourceLoaderRegistry {
  constructor(private readonly registry: ResourceTypeRegistry) {}

  async load(type: string, id: string): Promise<ResourceRef> {
    // 비UUID 입력이 Prisma 검증 오류(500)로 새어 응답 형상이 갈리면 그 자체가 존재 오라클이 된다.
    // 미등록 타입도 같은 이유로 500이 아닌 404 로 정규화한다(WT-13).
    if (!UUID_RE.test(id)) throw new NotFoundException();

    const descriptor = this.registry.get(type);
    if (!descriptor) throw new NotFoundException();

    const row = await descriptor.load(id);
    // 소프트 삭제 판정은 서술자가 아니라 **여기서 일괄** 수행한다 — 서술자마다 맡기면
    // 하나가 빠뜨렸을 때 삭제 리소스가 게이트를 통과하는 구멍이 된다(WT-25 가 그 사례).
    if (!row || row.deletedAt) throw new NotFoundException(); // 존재 은닉(§10.2): 404
    return { type, id: row.id, ownerId: row.ownerId, status: row.status, tenantId: row.tenantId };
  }
}
