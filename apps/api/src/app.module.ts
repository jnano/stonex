import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { CONTROLLERS } from './app.controllers';
import { PrismaService } from './prisma/prisma.service';
import { StorageService } from './storage/storage.service';
import { UploadSessionService } from './storage/upload-session.service';
import { RedisService } from './cache/redis.service';
import { PermissionCacheService } from './cache/permission-cache.service';
import { PermVersionService } from './cache/perm-version.service';
import { AuditService } from './audit/audit.service';
import { AuditInterceptor } from './audit/audit.interceptor';
import { AuditPartitionService } from './audit/partition.service';
import { AuthorizationService, GRANT_STORE } from './authorization/authorization.service';
import { PrismaGrantStore } from './authorization/grant.store';
import { SnapshotService } from './authorization/snapshot.service';
import { PolicyService } from './authorization/policy.service';
import { RoleGrantService } from './authorization/role-grant.service';
import { ResourceGrantService } from './authorization/resource-grant.service';
import { ResourceLoaderRegistry } from './authorization/resource-loader';
import { AuthGuard, TOKEN_VERIFIER } from './authorization/guards/auth.guard';
import { PermissionGuard } from './authorization/guards/permission.guard';
import { DominanceGuard } from './authorization/guards/dominance.guard';
import { MembersService } from './members/members.service';
import { RolesService } from './admin/roles.service';
import { FilesService } from './files/files.service';
import { SharesService } from './files/shares.service';
import { DomainsService } from './domains/domains.service';
import { DomainVerificationService } from './domains/verification.service';
import { DNS_TXT_RESOLVER, NodeDnsTxtResolver } from './domains/dns-resolver';
import { SuperAdminGuardService } from './members/super-admin-guard.service';
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
    ScheduleModule.forRoot(),
    /**
     * 속도 제한은 **throttler 를 하나만 등록한다.**
     *
     * `@nestjs/throttler` v6 는 등록된 *모든* named throttler 를 전 라우트에 적용한다 —
     * `@Throttle` 은 해당 라우트에서 값을 **덮어쓸 뿐, 다른 throttler 를 끄지 않는다.**
     * 그래서 `auth`(5회/분)를 함께 등록해 두면 인증 API 뿐 아니라 **앱의 모든 엔드포인트가
     * 분당 5회로 제한된다** — 정상 사용자가 목록을 여섯 번만 새로고침해도 429 를 받는다.
     * (G-1 매트릭스의 마지막 행이 항상 429 로 기록되고 있어 WP-12 에서 발견됐다.)
     *
     * 인증 API 의 §10.4 제한(5회/분)은 그 라우트에서 `default` 를 덮어써 구현한다.
     */
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
  ],
  controllers: CONTROLLERS,
  providers: [
    PrismaService,
    StorageService,
    UploadSessionService,
    RedisService,
    PermissionCacheService,
    PermVersionService,
    AuditService,
    AuditPartitionService,
    SnapshotService,
    PolicyService,
    RoleGrantService,
    ResourceGrantService,
    ResourceLoaderRegistry,
    PrismaGrantStore,
    { provide: GRANT_STORE, useExisting: PrismaGrantStore },
    AuthorizationService,
    TokenService,
    TotpService,
    AuthService,
    MembersService,
    RolesService,
    FilesService,
    SharesService,
    DomainsService,
    DomainVerificationService,
    // §13.2 미결(HTML 파일 방식 병행)이 결정되면 이 바인딩만 교체한다
    { provide: DNS_TXT_RESOLVER, useClass: NodeDnsTxtResolver },
    SuperAdminGuardService,
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
    // 조회 접근 로그 전용 — 권한 변경 감사는 서비스 계층(recordAudit)이 담당한다(§7.4)
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
