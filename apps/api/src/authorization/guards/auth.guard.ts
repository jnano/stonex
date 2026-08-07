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
 * WP-3 시점에는 JWT 체계(WP-2)가 없으므로 스텁이 주입된다 — 스텁은 전 요청을 거부한다.
 * WP-2 에서 JWT(sub·tenant·pv·exp) 검증 구현으로 교체하며, pv 불일치 거부(§8.3)도 그때 편입된다.
 */
export interface TokenVerifier {
  /** Authorization 헤더에서 사용자 id를 확정. 실패 시 null */
  verify(authorizationHeader: string | undefined): Promise<{ userId: string } | null>;
}

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** WP-2 전까지의 기본 구현: 인증 불가 — 공개 엔드포인트 외 전부 401 (Default Deny 정신) */
export class RejectAllTokenVerifier implements TokenVerifier {
  async verify(): Promise<null> {
    return null;
  }
}

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
    const verified = await this.verifier.verify(request.headers.authorization);
    if (!verified) throw new UnauthorizedException();

    const subject = await this.snapshots.forUser(verified.userId);
    if (!subject) throw new UnauthorizedException();
    request.subject = subject;
    return true;
  }
}
