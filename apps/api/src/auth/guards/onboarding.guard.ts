import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_META } from '../../authorization/decorators';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthedRequest } from '../../authorization/guards/auth.guard';
import { isOnboardingComplete, isPathAllowedDuringOnboarding } from '../onboarding';

/**
 * 온보딩 게이트 Guard (기획서 §8.5, RT-8).
 * 온보딩 플래그가 남아 있는 세션은 온보딩 API 외의 일반·관리 API 접근이 차단된다.
 * AuthGuard 다음, PermissionGuard 앞에서 실행되도록 등록 순서를 지킨다.
 *
 * 이 하나의 게이트를 최초 SUPER_ADMIN 시드(WP-1)와 requires_2fa 역할 부여 시의
 * 재로그인 강제(WP-5)가 공유한다 — 메커니즘 이원화 금지.
 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const subject = request.subject;
    if (!subject) return true; // 미인증은 AuthGuard 가 이미 처리

    const user = await this.prisma.user.findUnique({
      where: { id: subject.id },
      select: { must_change_password: true, totp_enrollment_required: true },
    });
    if (!user) throw new ForbiddenException();

    const complete = isOnboardingComplete({
      mustChangePassword: user.must_change_password,
      totpEnrollmentRequired: user.totp_enrollment_required,
    });
    if (complete) return true;

    if (isPathAllowedDuringOnboarding(request.path)) return true;
    throw new ForbiddenException('온보딩 미완료');
  }
}
