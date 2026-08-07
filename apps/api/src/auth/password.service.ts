import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const MIN_LENGTH = 10; // 기획서 §10.4
const ARGON2ID = 2;

/** 유출 비밀번호 조회 인터페이스 — 테스트·오프라인 환경에서 교체 가능 */
export interface BreachChecker {
  /** 유출 목록에 존재하면 true */
  isBreached(password: string): Promise<boolean>;
}

export const BREACH_CHECKER = Symbol('BREACH_CHECKER');

/**
 * HIBP k-anonymity 조회 (기획서 §10.4).
 * SHA-1 해시의 앞 5자만 외부에 전송하므로 비밀번호·전체 해시는 노출되지 않는다.
 * 조회 실패(네트워크 장애)는 통과로 처리한다 — 외부 서비스 장애가 가입·변경을 막지 않게 한다.
 */
@Injectable()
export class HibpBreachChecker implements BreachChecker {
  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
      const body = await res.text();
      return body.split('\n').some((line) => line.split(':')[0]?.trim() === suffix);
    } catch {
      return false;
    }
  }
}

/** 항상 통과하는 구현 — 테스트·오프라인 개발용 */
export class AllowAllBreachChecker implements BreachChecker {
  async isBreached(): Promise<boolean> {
    return false;
  }
}

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: 'TOO_SHORT' | 'BREACHED';
}

/** 비밀번호 해시·검증·정책 (argon2id, 최소 10자, 유출 목록 대조 — §10.4) */
@Injectable()
export class PasswordService {
  constructor(private readonly breachChecker: BreachChecker) {}

  async checkPolicy(password: string): Promise<PasswordPolicyResult> {
    if (password.length < MIN_LENGTH) return { ok: false, reason: 'TOO_SHORT' };
    if (await this.breachChecker.isBreached(password)) return { ok: false, reason: 'BREACHED' };
    return { ok: true };
  }

  async hash(password: string): Promise<string> {
    return argonHash(password, { algorithm: ARGON2ID });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argonVerify(passwordHash, password, { algorithm: ARGON2ID });
    } catch {
      return false;
    }
  }
}
