import { Injectable } from '@nestjs/common';
import { TokenVerifier } from '../authorization/guards/auth.guard';
import { TokenService } from './token.service';

/**
 * JWT TokenVerifier 구현 — WP-3의 RejectAllTokenVerifier 스텁을 대체한다.
 *
 * 서명·만료 검증과 클레임 추출까지만 담당한다.
 * pv 대조(§8.3)는 AuthGuard 가 스냅샷·DB 와 함께 수행한다 — 여기서 DB 를 다시 조회하면
 * 매 요청 중복 조회가 된다(캐시 도입 취지 상실).
 */
@Injectable()
export class JwtTokenVerifier implements TokenVerifier {
  constructor(private readonly tokens: TokenService) {}

  async verify(authorizationHeader: string | undefined): Promise<{ userId: string; pv: number } | null> {
    if (!authorizationHeader?.startsWith('Bearer ')) return null;
    const claims = await this.tokens.verifyAccess(authorizationHeader.slice('Bearer '.length));
    if (!claims) return null;
    return { userId: claims.sub, pv: claims.pv };
  }
}
