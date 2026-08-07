import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PUBLIC_META } from '../decorators';
import { SnapshotService } from '../snapshot.service';
import { SubjectSnapshot } from '../types';

/** request 에 확정된 주체를 싣는 키 */
export interface AuthedRequest extends Request {
  subject?: SubjectSnapshot;
}

/**
 * 토큰 검증 인터페이스 (§7.4 [1]).
 * 서명·만료 검증과 클레임 추출만 담당한다. pv 대조는 AuthGuard 가 스냅샷과 함께 수행한다.
 */
export interface TokenVerifier {
  /** Authorization 헤더에서 클레임을 확정. 실패 시 null */
  verify(authorizationHeader: string | undefined): Promise<{ userId: string; pv: number } | null>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** WP-2 전까지 사용하던 기본 구현 — 전 요청 거부(Default Deny). 테스트 보조용으로 유지 */
export class RejectAllTokenVerifier implements TokenVerifier {
  async verify(): Promise<null> {
    return null;
  }
}

/**
 * 주체 확정 Guard (§7.4 [1], §8.3).
 *
 * pv 대조 체인: JWT 의 pv ↔ 스냅샷(캐시)의 pv ↔ (불일치 시) DB 재구성분의 pv.
 * 캐시가 stale 이어서 생긴 불일치와 실제 권한 회수를 구분하기 위해, 1차 불일치에서 바로 거부하지 않고
 * DB 에서 재구성해 한 번 더 대조한다. DB 값과도 다르면 Access Token 을 거부하고 재발급을 요구한다
 * — 이로써 권한 회수가 토큰 만료를 기다리지 않고 수 초 내에 전파된다.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly snapshots: SnapshotService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_META, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const claims = await this.verifier.verify(request.headers.authorization);
    if (!claims) throw new UnauthorizedException();

    let subject = await this.snapshots.forUser(claims.userId);
    if (!subject) throw new UnauthorizedException();

    if (subject.permVersion !== claims.pv) {
      // 캐시가 오래됐을 수 있으므로 권위 소스(DB)로 한 번 더 확인한다
      subject = await this.snapshots.rebuildFromDb(claims.userId);
      if (!subject || subject.permVersion !== claims.pv) throw new UnauthorizedException();
    }

    request.subject = subject;
    return true;
  }
}
