import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CONTROLLERS } from './app.controllers';
import { PrismaService } from './prisma/prisma.service';
import { AuditService } from './audit/audit.service';
import { AuthorizationService, GRANT_STORE } from './authorization/authorization.service';
import { PrismaGrantStore } from './authorization/grant.store';
import { SnapshotService } from './authorization/snapshot.service';
import { PolicyService } from './authorization/policy.service';
import { ResourceLoaderRegistry } from './authorization/resource-loader';
import { AuthGuard, RejectAllTokenVerifier, TOKEN_VERIFIER } from './authorization/guards/auth.guard';
import { PermissionGuard } from './authorization/guards/permission.guard';
import { DominanceGuard } from './authorization/guards/dominance.guard';

/**
 * 루트 모듈. 전역 Guard 는 §7.4 순서로 실행된다:
 * [1] AuthGuard(주체 확정) → [2~3] PermissionGuard(선언 수집·평가기) → [4] DominanceGuard(관리 행위 우위).
 * 미선언 엔드포인트 기동 차단(§7.3)은 main.ts 의 enforceEndpointDeclarations 가 수행한다.
 */
@Module({
  controllers: CONTROLLERS,
  providers: [
    PrismaService,
    AuditService,
    SnapshotService,
    PolicyService,
    ResourceLoaderRegistry,
    { provide: GRANT_STORE, useClass: PrismaGrantStore },
    AuthorizationService,
    // WP-2 에서 JWT 구현으로 교체된다 — 그때까지 인증 요구 라우트는 전부 401
    { provide: TOKEN_VERIFIER, useClass: RejectAllTokenVerifier },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: DominanceGuard },
  ],
})
export class AppModule {}
