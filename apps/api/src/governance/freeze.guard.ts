import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_META, PermissionRequirement } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { GovernanceFreezeService } from './freeze.service';

/**
 * L-2 동결 강제 (기획서 §14.4) — Guard 체계의 마지막 단계.
 *
 * **평가기에 넣지 않는 이유**: 동결은 "이 사람이 이 리소스에 권한이 있는가"라는 물음과 다른 축이다.
 * 평가기에 섞으면 §4.7의 5단계가 6단계가 되고, 시뮬레이터·매트릭스가 재현해야 할 상태가 하나 늘어난다.
 *
 * **동결 대상을 Permission 집합으로 정의하는 이유**: 라우트 목록으로 두면 새 API 를 추가할 때
 * 조용히 누락된다. 여기서는 그 엔드포인트가 선언한 Permission 이 집합에 드는지만 본다 —
 * 신규 API 라도 권한을 옮기는 코드를 게이트로 쓰면 자동으로 동결 대상이 된다.
 */
@Injectable()
export class FreezeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly freeze: GovernanceFreezeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<PermissionRequirement | undefined>(
      PERMISSION_META,
      context.getHandler(),
    );
    if (!requirement || !GovernanceFreezeService.isFrozenScope(requirement.code)) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const subject = request.subject;
    if (!subject) return true; // 인증은 AuthGuard 가 이미 판정했다

    // 동결이면 403 + 명시 사유로 거부한다(존재 은닉 대상이 아니다 — 본인에게 숨기면 문의만 는다)
    await this.freeze.assertNotFrozen(subject.id);
    return true;
  }
}
