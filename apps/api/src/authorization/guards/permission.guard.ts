import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthorizationService } from '../authorization.service';
import { PERMISSION_META, PUBLIC_META, PermissionRequirement } from '../decorators';
import { ResourceLoaderRegistry } from '../resource-loader';
import { ResourceRef } from '../types';
import { AuthedRequest } from './auth.guard';

/** request 에 로드된 리소스를 싣는 키 — 핸들러가 재사용한다(§4.7 이중 조회 방지) */
export interface ResourceRequest extends AuthedRequest {
  resource?: ResourceRef;
}

/**
 * @RequirePermission 선언 수집 → 평가기 실행 (§7.4 [2]~[3]).
 * 리소스형 선언이면 리소스를 1회 로드해 request.resource 로 공유한다.
 * 거부 응답: 조회형(리소스형) 요청은 404(존재 은닉, §10.2), 그 외 403.
 * 거부 사유(어느 단계에서 거부됐는지)는 응답에 노출하지 않는다 — 서버 로그·시뮬레이터 전용.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
    private readonly loaders: ResourceLoaderRegistry,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const requirement = this.reflector.get<PermissionRequirement | undefined>(
      PERMISSION_META,
      context.getHandler(),
    );
    // 미선언은 기동 시점에 차단되므로(startup-check) 여기 도달할 수 없다 — 방어적 거부(INV-5)
    if (!requirement) throw new ForbiddenException();

    const request = context.switchToHttp().getRequest<ResourceRequest>();
    const subject = request.subject;
    if (!subject) throw new ForbiddenException();

    let resource: ResourceRef | undefined;
    if (requirement.resource) {
      const raw = request.params[requirement.resource.param];
      const id = Array.isArray(raw) ? raw[0] : raw;
      if (!id) throw new NotFoundException();
      resource = await this.loaders.load(requirement.resource.type, id);
      request.resource = resource;
    }

    const decision = await this.authz.can(subject, requirement.code, resource);
    if (!decision.allow) {
      // 리소스형 접근 거부는 존재 자체를 숨긴다(§10.2)
      if (resource) throw new NotFoundException();
      throw new ForbiddenException();
    }
    return true;
  }
}
