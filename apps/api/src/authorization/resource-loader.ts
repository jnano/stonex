import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceRef } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 리소스 1회 로드 (§4.7): 리소스형 API는 Guard 단계에서 로드하여
 * 평가기와 핸들러가 공유한다(이중 조회 방지). request.resource 로 전달.
 * 신규 리소스 타입은 여기 로더 등록만으로 편입된다(§9.1).
 */
@Injectable()
export class ResourceLoaderRegistry {
  constructor(private readonly prisma: PrismaService) {}

  async load(type: string, id: string): Promise<ResourceRef> {
    // 비UUID 입력이 Prisma 검증 오류(500)로 새어 응답 형상이 갈리면 그 자체가 존재 오라클이 된다.
    // 미등록 타입도 같은 이유로 500이 아닌 404 로 정규화한다(WT-13).
    if (!UUID_RE.test(id)) throw new NotFoundException();

    switch (type) {
      case 'file': {
        const f = await this.prisma.file.findUnique({ where: { id } });
        // 소프트 삭제된 행은 존재하지 않는 것으로 취급한다 — 평가기 1단계는 status 만 보므로,
        // deleted_at 만 채우고 status 를 남긴 삭제 구현이 게이트를 통과하는 구멍이 있었다(WT-25).
        if (!f || f.deleted_at) throw new NotFoundException(); // 존재 은닉(§10.2): 404
        return { type, id: f.id, ownerId: f.owner_id, status: f.status, tenantId: f.tenant_id };
      }
      case 'domain': {
        const d = await this.prisma.domain.findUnique({ where: { id } });
        if (!d || d.deleted_at) throw new NotFoundException();
        return { type, id: d.id, ownerId: d.owner_id, status: d.status, tenantId: d.tenant_id };
      }
      default:
        throw new NotFoundException();
    }
  }
}
