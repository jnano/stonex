import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
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
import { AuditRetentionService } from './audit/retention.service';
import { AuthorizationService, GRANT_STORE } from './authorization/authorization.service';
import { PrismaGrantStore } from './authorization/grant.store';
import { SnapshotService } from './authorization/snapshot.service';
import { PolicyService } from './authorization/policy.service';
import { RoleGrantService } from './authorization/role-grant.service';
import { ResourceGrantService } from './authorization/resource-grant.service';
import { ResourceLoaderRegistry } from './authorization/resource-loader';
import { ResourceTypeRegistry } from './authorization/resource-registry';
import { fileDescriptor } from './files/file.descriptor';
import { domainDescriptor } from './domains/domain.descriptor';
import { OwnerCleanupRegistry } from './authorization/owner-cleanup';
import { FileOwnerCleanupHook } from './files/file.cleanup';
import { DomainOwnerCleanupHook } from './domains/domain.cleanup';
import { OwnerCleanupWorker } from './members/owner-cleanup.worker';
import { AuthGuard, TOKEN_VERIFIER } from './authorization/guards/auth.guard';
import { PermissionGuard } from './authorization/guards/permission.guard';
import { DominanceGuard } from './authorization/guards/dominance.guard';
import { MembersService } from './members/members.service';
import { EmailChangeService } from './members/email-change.service';
import { MemberAnonymizationService } from './members/anonymization.service';
import { RolesService } from './admin/roles.service';
import { AuditQueryService } from './admin/audit-query.service';
import { PermissionSimulatorService } from './admin/simulator.service';
import { VersionService } from './admin/version.service';
import { FilesService } from './files/files.service';
import { SharesService } from './files/shares.service';
import { DomainsService } from './domains/domains.service';
import { DomainVerificationService } from './domains/verification.service';
import { DomainDelegationsService } from './domains/delegations.service';
import { DomainTransfersService } from './domains/transfers.service';
import { GovernancePatrolService } from './governance/patrol.service';
import { AuditCheckpointService } from './governance/checkpoint.service';
import { GOVERNANCE_NOTIFIER, LogGovernanceNotifier } from './governance/notifier';
import { GovernanceFreezeService } from './governance/freeze.service';
import { FreezeGuard } from './governance/freeze.guard';
import { GovernanceStatusService } from './governance/governance.service';
import { AnomalyDetectionService } from './governance/anomaly.service';
import { DNS_TXT_RESOLVER, NodeDnsTxtResolver } from './domains/dns-resolver';
import { SuperAdminGuardService } from './members/super-admin-guard.service';
import { AuthService } from './auth/auth.service';
import { TokenService } from './auth/token.service';
import { TotpService } from './auth/totp.service';
import { JwtTokenVerifier } from './auth/jwt-token-verifier';
import { OnboardingGuard } from './auth/guards/onboarding.guard';
import { ConfiguredMailer, MAILER } from './auth/mailer';
import { SettingsService } from './settings/settings.service';
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
    AuditRetentionService,
    SnapshotService,
    PolicyService,
    RoleGrantService,
    ResourceGrantService,
    // 리소스 타입 레지스트리 (WP-K1) — 서술자 등록은 커널이 아니라 여기(확장 지점)서 한다.
    // 신규 리소스 타입은 이 팩토리에 서술자 한 줄을 더하는 것으로 편입된다(§9.1).
    {
      provide: ResourceTypeRegistry,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): ResourceTypeRegistry => {
        const registry = new ResourceTypeRegistry(prisma);
        registry.register(fileDescriptor(prisma));
        registry.register(domainDescriptor(prisma));
        return registry;
      },
    },
    ResourceLoaderRegistry,
    // 소유자 정리 훅 (WP-K2) — 훅 등록도 여기(확장 지점)서 한다. 커널은 목록만 안다.
    FileOwnerCleanupHook,
    DomainOwnerCleanupHook,
    {
      provide: OwnerCleanupRegistry,
      inject: [FileOwnerCleanupHook, DomainOwnerCleanupHook],
      useFactory: (file: FileOwnerCleanupHook, domain: DomainOwnerCleanupHook): OwnerCleanupRegistry => {
        const registry = new OwnerCleanupRegistry();
        registry.register(file);
        registry.register(domain);
        return registry;
      },
    },
    OwnerCleanupWorker,
    PrismaGrantStore,
    { provide: GRANT_STORE, useExisting: PrismaGrantStore },
    AuthorizationService,
    TokenService,
    TotpService,
    AuthService,
    MembersService,
    EmailChangeService,
    MemberAnonymizationService,
    RolesService,
    AuditQueryService,
    PermissionSimulatorService,
    VersionService,
    FilesService,
    SharesService,
    DomainsService,
    DomainVerificationService,
    DomainDelegationsService,
    DomainTransfersService,
    GovernancePatrolService,
    AuditCheckpointService,
    GovernanceFreezeService,
    GovernanceStatusService,
    AnomalyDetectionService,
    // 운영에서는 webhook·이메일 어댑터로 교체한다 (인터페이스만 지키면 순찰 코드는 그대로)
    { provide: GOVERNANCE_NOTIFIER, useClass: LogGovernanceNotifier },
    // §13.2 미결(HTML 파일 방식 병행)이 결정되면 이 바인딩만 교체한다
    { provide: DNS_TXT_RESOLVER, useClass: NodeDnsTxtResolver },
    SuperAdminGuardService,
    SettingsService,
    /**
     * 메일 발송 — **설정은 DB 한 곳에서 온다**(범용 배포 지원).
     * 환경 변수 폴백을 두지 않는 이유는, 두 곳에서 읽으면 "화면에는 A 인데 실제로는 B" 상태가
     * 생기고 그걸 추적하기가 매우 어렵기 때문이다.
     */
    { provide: MAILER, useClass: ConfiguredMailer },
    { provide: BREACH_CHECKER, useClass: HibpBreachChecker },
    {
      provide: PasswordService,
      useFactory: (checker: BreachChecker) => new PasswordService(checker),
      inject: [BREACH_CHECKER],
    },
    // WP-3의 RejectAll 스텁을 JWT 검증(pv 대조 포함)으로 교체 — WP-2
    { provide: TOKEN_VERIFIER, useClass: JwtTokenVerifier },
    /**
     * 입력 방향 화이트리스트 (§10.2). **모듈 프로바이더로 둔다.**
     * bootstrap 에만 등록하면 테스트가 부팅하는 앱에는 적용되지 않아, `owner_id` 같은 필드가
     * 들어오는 것을 막는 이 방어가 **어떤 검증에도 걸리지 않는다**(WP-15에서 발견).
     * 출력 화이트리스트(직렬화)만으로는 소유권 탈취 입력을 막지 못한다(§10.1).
     */
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: OnboardingGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: DominanceGuard },
    // [5] L-2 동결 — 권한을 옮기는 Permission 을 게이트로 쓰는 엔드포인트만 대상이다(§14.4)
    { provide: APP_GUARD, useClass: FreezeGuard },
    // 조회 접근 로그 전용 — 권한 변경 감사는 서비스 계층(recordAudit)이 담당한다(§7.4)
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
