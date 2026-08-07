import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceRef } from './types';

/**
 * 리소스 1회 로드 (§4.7): 리소스형 API는 Guard 단계에서 로드하여
 * 평가기와 핸들러가 공유한다(이중 조회 방지). request.resource 로 전달.
 * 신규 리소스 타입은 여기 로더 등록만으로 편입된다(§9.1).
 */
@Injectable()
export class ResourceLoaderRegistry {
  constructor(private readonly prisma: PrismaService) {}

  async load(type: string, id: string): Promise<ResourceRef> {
    switch (type) {
      case 'file': {
        const f = await this.prisma.file.findUnique({ where: { id } });
        if (!f) throw new NotFoundException(); // 존재 은닉(§10.2): 404
        return { type, id: f.id, ownerId: f.owner_id, status: f.status, tenantId: f.tenant_id };
      }
      case 'domain': {
        const d = await this.prisma.domain.findUnique({ where: { id } });
        if (!d) throw new NotFoundException();
        return { type, id: d.id, ownerId: d.owner_id, status: d.status, tenantId: d.tenant_id };
      }
      default:
        throw new Error(`등록되지 않은 리소스 타입: ${type}`);
    }
  }
}
