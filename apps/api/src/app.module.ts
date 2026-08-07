import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CONTROLLERS } from './app.controllers';
import { PrismaService } from './prisma/prisma.service';
import { AuditService } from './audit/audit.service';
import { AuthorizationService, GRANT_STORE } from './authorization/authorization.service';
import { PrismaGrantStore } from './authorization/grant.store';
import { SnapshotService } from './authorization/snapshot.service';
import { PolicyService } from './authorization/policy.service';
import { ResourceLoaderRegistry } from './authorization/resource-loader';
import { AuthGuard, TOKEN_VERIFIER } from './authorization/guards/auth.guard';
import { PermissionGuard } from './authorization/guards/permission.guard';
import { DominanceGuard } from './authorization/guards/dominance.guard';
import { AuthService } from './auth/auth.service';
import { TokenService } from './auth/token.service';
import { TotpService } from './auth/totp.service';
import { JwtTokenVerifier } from './auth/jwt-token-verifier';
import { OnboardingGuard } from './auth/guards/onboarding.guard';
import { ConsoleMailer, MAILER } from './auth/mailer';
import {
  BREACH_CHECKER,
  BreachChecker,
  HibpBreachChecker,
  PasswordService,
} from './auth/password.service';

/**
 * 루트 모듈. 전역 Guard 실행 순서 (§7.4 + §8.5):
 * [0] ThrottlerGuard(속도 제한) → [1] AuthGuard(주체 확정)
 * → [1.5] OnboardingGuard(온보딩 미완료 세션 범위 제한)
 * → [2~3] PermissionGuard(선언 수집·평가기) → [4] DominanceGuard(관리 행위 우위)
 * 미선언 엔드포인트 기동 차단(§7.3)은 main.ts 의 enforceEndpointDeclarations 가 수행한다.
 */
@Module({
  imports: [
    // 기본 정책 + 인증 API 전용 정책(5회/분 — §10.4)은 컨트롤러에서 @Throttle 로 선택한다
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 120 },
      { name: 'auth', ttl: 60_000, limit: 5 },
    ]),
  ],
  controllers: CONTROLLERS,
  providers: [
    PrismaService,
    AuditService,
    SnapshotService,
    PolicyService,
    ResourceLoaderRegistry,
    { provide: GRANT_STORE, useClass: PrismaGrantStore },
    AuthorizationService,
    TokenService,
    TotpService,
    AuthService,
    { provide: MAILER, useClass: ConsoleMailer },
    { provide: BREACH_CHECKER, useClass: HibpBreachChecker },
    {
      provide: PasswordService,
      useFactory: (checker: BreachChecker) => new PasswordService(checker),
      inject: [BREACH_CHECKER],
    },
    // WP-3의 RejectAll 스텁을 JWT 검증(pv 대조 포함)으로 교체 — WP-2
    { provide: TOKEN_VERIFIER, useClass: JwtTokenVerifier },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OnboardingGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: DominanceGuard },
  ],
})
export class AppModule {}
