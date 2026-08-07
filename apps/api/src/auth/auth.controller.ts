import { Body, Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedOnly, Public } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { AuthService, TokenPair } from './auth.service';

/**
 * 인증 엔드포인트 (기획서 §6.1, §7.2).
 * 인증 API 속도 제한 5회/분/IP (§10.4) — @Throttle 로 선언.
 * 온보딩 경로는 인증은 요구하되 Permission 검사 대상이 아니므로 @AuthenticatedOnly 로 선언하고,
 * 온보딩 게이트(§8.5 ONBOARDING_ALLOWED_PATHS)가 미완료 세션에도 이 경로만 허용한다.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  async signup(@Body() body: { email: string; password: string; name: string }): Promise<{ ok: true }> {
    await this.auth.signup(body.email, body.password, body.name);
    return { ok: true }; // 계정 존재 여부를 응답으로 구분할 수 없게 한다(§10.2)
  }

  @Public()
  @Post('verify-email')
  async verifyEmail(@Body() body: { token: string }): Promise<{ ok: true }> {
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }

  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(@Body() body: { email: string; password: string }): Promise<TokenPair> {
    return this.auth.login(body.email, body.password);
  }

  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('refresh')
  async refresh(@Body() body: { refreshToken: string }): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post('password-reset/request')
  async requestReset(@Body() body: { email: string }): Promise<{ ok: true }> {
    await this.auth.requestPasswordReset(body.email);
    return { ok: true }; // 계정 유무와 무관하게 동일 응답
  }

  @Public()
  @Post('password-reset/confirm')
  async confirmReset(@Body() body: { token: string; password: string }): Promise<{ ok: true }> {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }

  // ── 온보딩 (§8.5) — 인증 필요, 온보딩 미완료 세션에도 허용되는 경로 ──

  @AuthenticatedOnly()
  @Get('onboarding/status')
  async onboardingStatus(@Req() req: AuthedRequest): Promise<{ mustChangePassword: boolean; totpEnrollmentRequired: boolean }> {
    return this.auth.onboardingStatus(requireSubjectId(req));
  }

  @AuthenticatedOnly()
  @Post('onboarding/password')
  async onboardPassword(
    @Req() req: AuthedRequest,
    @Body() body: { password: string },
  ): Promise<{ ok: true }> {
    await this.auth.completePasswordOnboarding(requireSubjectId(req), body.password);
    return { ok: true };
  }

  @AuthenticatedOnly()
  @Post('onboarding/totp')
  async onboardTotpBegin(@Req() req: AuthedRequest): Promise<{ keyUri: string }> {
    // keyUri 안에 시크릿이 포함되므로 등록 진행 중인 본인에게만 반환된다
    return this.auth.beginTotpEnrollment(requireSubjectId(req));
  }

  @AuthenticatedOnly()
  @Post('onboarding/totp/confirm')
  async onboardTotpConfirm(
    @Req() req: AuthedRequest,
    @Body() body: { code: string },
  ): Promise<{ ok: true }> {
    await this.auth.confirmTotpEnrollment(requireSubjectId(req), body.code);
    return { ok: true };
  }
}

/** @AuthenticatedOnly 경로에서 AuthGuard 가 확정한 주체 id를 꺼낸다 */
function requireSubjectId(req: AuthedRequest): string {
  const id = req.subject?.id;
  if (!id) throw new UnauthorizedException();
  return id;
}
