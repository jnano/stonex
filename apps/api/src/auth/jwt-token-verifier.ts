import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenVerifier } from '../authorization/guards/auth.guard';
import { TokenService } from './token.service';

/**
 * JWT TokenVerifier 구현 — WP-3의 RejectAllTokenVerifier 스텁을 대체한다.
 *
 * pv 대조(§8.3): JWT 의 pv 가 DB 의 users.perm_version 과 다르면 토큰을 거부한다.
 * 이로써 역할 회수·정지가 Access Token 만료를 기다리지 않고 즉시 전파된다
 * (WP-4에서 Redis 스냅샷이 앞단에 붙어도 권위 소스는 DB 값 그대로 유지).
 */
@Injectable()
export class JwtTokenVerifier implements TokenVerifier {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async verify(authorizationHeader: string | undefined): Promise<{ userId: string } | null> {
    if (!authorizationHeader?.startsWith('Bearer ')) return null;
    const claims = await this.tokens.verifyAccess(authorizationHeader.slice('Bearer '.length));
    if (!claims) return null;

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { perm_version: true },
    });
    if (!user || user.perm_version !== claims.pv) return null; // pv 불일치 → 재발급 요구
    return { userId: claims.sub };
  }
}
