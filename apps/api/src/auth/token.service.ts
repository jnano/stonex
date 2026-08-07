import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';

/** Access Token 페이로드 (기획서 §8.1) — 역할·권한 목록은 절대 포함하지 않는다 */
export interface AccessClaims {
  sub: string; // user id
  tenant: string;
  pv: number; // perm_version — DB 값과 불일치하면 거부(§8.3)
}

export const ACCESS_TTL_SECONDS = 600; // 10분
export const REFRESH_TTL_DAYS = 14;

/**
 * 토큰 발급·검증 (기획서 §8.1).
 * - Access: JWT(HS256), 수명 10분, 페이로드는 sub·tenant·pv·exp 만.
 *   권한을 넣으면 회수가 만료까지 지연되는 구조적 결함이 생기므로 금지한다.
 * - Refresh: 불투명 랜덤 문자열. DB에는 SHA-256 해시만 저장하고 원문은 저장하지 않는다.
 */
@Injectable()
export class TokenService {
  private readonly secret: Uint8Array;

  constructor() {
    const raw = process.env.JWT_SECRET;
    if (!raw || raw.length < 32) {
      // 하드코딩 금지 + 취약 기본값 금지 — 미설정이면 기동 자체를 실패시킨다
      throw new Error('JWT_SECRET 환경 변수(32자 이상)가 필요합니다.');
    }
    this.secret = new TextEncoder().encode(raw);
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ tenant: claims.tenant, pv: claims.pv })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  /** 서명·만료 검증만 수행. pv 대조는 AuthGuard(DB 조회 후)에서 한다 */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.pv !== 'number' || typeof payload.tenant !== 'string') {
        return null;
      }
      return { sub: payload.sub, tenant: payload.tenant, pv: payload.pv };
    } catch {
      return null; // 서명 불일치·만료·형식 오류 — 사유는 노출하지 않는다(§10.2)
    }
  }

  /** 불투명 refresh 토큰 원문 생성 (호출자는 hash()만 저장한다) */
  createOpaqueToken(): string {
    return randomBytes(48).toString('base64url');
  }

  /** 토큰 원문 → 저장용 SHA-256 해시 (refresh·이메일 인증·비밀번호 재설정 공통) */
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  refreshExpiry(): Date {
    return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  }
}
