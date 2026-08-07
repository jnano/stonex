import { Injectable } from '@nestjs/common';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';

const ISSUER = 'stonex';

/**
 * TOTP(2FA) 등록·검증 — 기획서 §10.4.
 * 강제 대상 판정은 서수("OPERATOR 이상")가 아니라 역할의 requires_2fa 속성으로 한다(RT-11).
 * 시크릿은 users.totp_secret 에 보관하며 API 응답 직렬화에서 제외한다(§10.2).
 */
@Injectable()
export class TotpService {
  generateSecret(): string {
    return generateSecret();
  }

  /** 인증 앱 등록용 otpauth URI (시크릿을 포함하므로 본인에게만 반환) */
  keyUri(email: string, secret: string): string {
    return generateURI({ strategy: 'totp', issuer: ISSUER, label: email, secret });
  }

  /** 현재 시간 창의 코드 생성 — 테스트·검증 보조용 */
  generate(secret: string): string {
    return generateSync({ secret });
  }

  verify(secret: string, code: string): boolean {
    try {
      return verifySync({ secret, token: code }).valid;
    } catch {
      return false;
    }
  }
}
