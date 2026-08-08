import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { RoleGrantService } from '../authorization/role-grant.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';
import { MAILER, Mailer } from './mailer';
import { RedisService } from '../cache/redis.service';

/** 재등록 미확정 시크릿의 수명 — 확인을 끝내지 않으면 저절로 사라진다 */
const TOTP_REENROLL_TTL_SEC = Number(process.env.TOTP_REENROLL_TTL_SEC ?? 600);
const pendingTotpKey = (userId: string): string => `totp:pending:${userId}`;

const MAX_FAILED_LOGINS = 5; // AUTH-2
const LOCK_MINUTES = 15;
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * 인증 서비스 (기획서 §6.1 AUTH-1~4, §8.1~8.2, §8.5).
 * 권한 변경(가입 시 MEMBER 자동 부여)은 감사 기록과 동일 트랜잭션에서 수행한다(INV-6).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roleGrants: RoleGrantService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly redis: RedisService,
  ) {}

  // ── AUTH-1 회원가입 ────────────────────────────────────────────
  /** 가입 요청. 이메일 인증 완료 전까지 status=PENDING (평가기 0단계에서 전면 차단) */
  async signup(email: string, password: string, name: string): Promise<{ userId: string }> {
    const policy = await this.passwords.checkPolicy(password);
    if (!policy.ok) throw new BadRequestException('비밀번호 정책 위반');

    const existing = await this.prisma.user.findUnique({
      where: { tenant_id_email: { tenant_id: DEFAULT_TENANT_ID, email } },
    });
    // 계정 존재 여부를 응답으로 구분할 수 없게 한다(§10.2) — 중복이면 메일만 보내지 않고 동일 응답
    if (existing) return { userId: existing.id };

    const user = await this.prisma.user.create({
      data: {
        tenant_id: DEFAULT_TENANT_ID,
        email,
        password_hash: await this.passwords.hash(password),
        name,
        status: 'PENDING',
      },
    });
    await this.issueVerificationMail(user.id, email);
    return { userId: user.id };
  }

  private async issueVerificationMail(userId: string, email: string): Promise<void> {
    const raw = this.tokens.createOpaqueToken();
    await this.prisma.verificationToken.create({
      data: {
        user_id: userId,
        kind: 'EMAIL_VERIFY',
        token_hash: this.tokens.hash(raw),
        expires_at: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
      },
    });
    await this.mailer.send(email, '이메일 인증', `인증 토큰: ${raw}`);
  }

  /**
   * 이메일 인증 완료 → status=ACTIVE + MEMBER 역할 자동 부여.
   * 역할 부여는 권한 변경이므로 감사 기록과 동일 트랜잭션에서 수행한다(INV-6, RT-2).
   */
  async verifyEmail(rawToken: string): Promise<void> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { token_hash: this.tokens.hash(rawToken) },
    });
    if (!record || record.kind !== 'EMAIL_VERIFY' || record.used_at || record.expires_at < new Date()) {
      throw new BadRequestException('유효하지 않은 토큰');
    }
    const memberRole = await this.prisma.role.findUniqueOrThrow({
      where: { tenant_id_code: { tenant_id: DEFAULT_TENANT_ID, code: 'MEMBER' } },
    });

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.verificationToken.update({ where: { id: record.id }, data: { used_at: new Date() } });
      await tx.user.update({ where: { id: record.user_id }, data: { status: 'ACTIVE' } });
      // 역할 부여는 RoleGrantService 를 통해서만 한다 — 부여와 감사가 항상 함께 묶인다.
      // 기록 실패 시 상태 전환·부여 전체가 롤백된다(INV-6).
      await this.roleGrants.grant(tx, {
        tenantId: DEFAULT_TENANT_ID,
        userId: record.user_id,
        roleId: memberRole.id,
        roleCode: 'MEMBER',
        actorId: null, // 시스템 행위
        before: { roles: [], status: 'PENDING' },
      });
    });
    // 트랜잭션 커밋 후 캐시 무효화 — pv 증가는 위 트랜잭션에 포함되어 있다(§8.3 순서)
    await this.roleGrants.flushCache([record.user_id]);
  }

  // ── AUTH-2 로그인 ─────────────────────────────────────────────
  /** 실패 5회 시 15분 잠금. status≠ACTIVE 는 거부. 실패 사유는 구분해 노출하지 않는다 */
  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { tenant_id_email: { tenant_id: DEFAULT_TENANT_ID, email } },
    });
    if (!user) throw new UnauthorizedException();
    if (user.locked_until && user.locked_until > new Date()) throw new UnauthorizedException();

    const ok = await this.passwords.verify(user.password_hash, password);
    if (!ok) {
      const failed = user.failed_login_count + 1;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failed_login_count: failed,
          locked_until: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      throw new UnauthorizedException();
    }
    if (user.status !== 'ACTIVE') throw new UnauthorizedException();

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failed_login_count: 0, locked_until: null },
    });
    return this.issueTokenPair(user.id, user.tenant_id, user.perm_version, null);
  }

  /**
   * 개발 전용 로그인 — **비밀번호 확인만** 건너뛴다(auth/dev-login.ts 참조).
   *
   * 계정 존재·상태 검사는 그대로 받고 실제 토큰을 발급한다. 이후 Guard·평가기·pv·
   * 온보딩 게이트는 운영과 완전히 같은 경로를 탄다 — 그래야 개발에서 본 동작이
   * 배포에서도 같다. 이 메서드는 라우트가 등록될 때만 도달 가능하고, 그 등록은
   * DEV_LOGIN=1 + 비프로덕션에서만 일어난다.
   */
  async devLogin(email: string): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { tenant_id_email: { tenant_id: DEFAULT_TENANT_ID, email } },
    });
    // 없는 계정을 만들어 주지 않는다 — 시드가 만든 계정으로만 들어간다
    if (!user) throw new UnauthorizedException();
    if (user.status !== 'ACTIVE') throw new UnauthorizedException();
    return this.issueTokenPair(user.id, user.tenant_id, user.perm_version, null);
  }

  /** family 를 넘기면 회전(같은 family 유지), null 이면 새 family 시작 */
  private async issueTokenPair(
    userId: string,
    tenantId: string,
    permVersion: number,
    familyId: string | null,
  ): Promise<TokenPair> {
    const raw = this.tokens.createOpaqueToken();
    const created = await this.prisma.refreshToken.create({
      data: {
        user_id: userId,
        token_hash: this.tokens.hash(raw),
        family_id: familyId ?? crypto.randomUUID(),
        expires_at: this.tokens.refreshExpiry(),
      },
    });
    const accessToken = await this.tokens.signAccess({ sub: userId, tenant: tenantId, pv: permVersion });
    return { accessToken, refreshToken: `${created.family_id}.${raw}` };
  }

  // ── AUTH-3 토큰 갱신 ──────────────────────────────────────────
  /**
   * 회전 + 재사용 탐지 + 상태 재검증 + 2FA 우회 차단.
   * - 폐기된 토큰 재사용 → family 전체 폐기(탈취 탐지)
   * - status≠ACTIVE → 갱신 거부 + family 폐기 (정지 계정의 세션 연장 차단)
   * - requires_2fa 역할 보유 + TOTP 미등록 → 갱신 거부 (RT-7-b 방어 심층)
   */
  async refresh(presented: string): Promise<TokenPair> {
    const [, raw] = presented.split('.');
    if (!raw) throw new UnauthorizedException();
    const record = await this.prisma.refreshToken.findUnique({
      where: { token_hash: this.tokens.hash(raw) },
      include: {
        user: { include: { user_roles: { include: { role: true } } } },
      },
    });
    if (!record) throw new UnauthorizedException();

    if (record.revoked_at || record.expires_at < new Date()) {
      // 재사용 탐지: 이미 폐기된 토큰이 다시 제시됨 → family 전체 폐기
      await this.revokeFamily(record.family_id);
      throw new UnauthorizedException();
    }
    if (record.user.status !== 'ACTIVE') {
      await this.revokeFamily(record.family_id);
      throw new UnauthorizedException();
    }
    const needs2fa = record.user.user_roles.some((ur) => ur.role.requires_2fa);
    if (needs2fa && (record.user.totp_secret === null || record.user.totp_enrollment_required)) {
      // 갱신 경로로 2FA 강제를 우회하지 못하게 한다 (RT-7)
      throw new UnauthorizedException();
    }

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked_at: new Date() },
    });
    return this.issueTokenPair(record.user_id, record.user.tenant_id, record.user.perm_version, record.family_id);
  }

  /** 정지·삭제·비밀번호 변경 시 세션 즉시 무효화 (MEM-4/6, AUTH-4) */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  // ── AUTH-4 비밀번호 재설정 ────────────────────────────────────
  /** 계정 존재 여부를 응답으로 알 수 없게 한다(§10.2) — 항상 동일 응답 */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { tenant_id_email: { tenant_id: DEFAULT_TENANT_ID, email } },
    });
    if (!user) return;
    const raw = this.tokens.createOpaqueToken();
    await this.prisma.verificationToken.create({
      data: {
        user_id: user.id,
        kind: 'PASSWORD_RESET',
        token_hash: this.tokens.hash(raw),
        expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });
    await this.mailer.send(email, '비밀번호 재설정', `재설정 토큰: ${raw}`);
  }

  /** 재설정 완료 시 전체 refresh 패밀리 폐기 (AUTH-4) */
  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const policy = await this.passwords.checkPolicy(newPassword);
    if (!policy.ok) throw new BadRequestException('비밀번호 정책 위반');

    const record = await this.prisma.verificationToken.findUnique({
      where: { token_hash: this.tokens.hash(rawToken) },
    });
    if (!record || record.kind !== 'PASSWORD_RESET' || record.used_at || record.expires_at < new Date()) {
      throw new BadRequestException('유효하지 않은 토큰');
    }
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.verificationToken.update({ where: { id: record.id }, data: { used_at: new Date() } });
      await tx.user.update({
        where: { id: record.user_id },
        data: {
          password_hash: await this.passwords.hash(newPassword),
          must_change_password: false,
          failed_login_count: 0,
          locked_until: null,
        },
      });
      await tx.refreshToken.updateMany({
        where: { user_id: record.user_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    });
  }

  // ── 온보딩 (§8.5) ─────────────────────────────────────────────
  /** 온보딩 비밀번호 변경 — 완료 시 must_change_password 해제 */
  async completePasswordOnboarding(userId: string, newPassword: string): Promise<void> {
    const policy = await this.passwords.checkPolicy(newPassword);
    if (!policy.ok) throw new BadRequestException('비밀번호 정책 위반');
    await this.prisma.user.update({
      where: { id: userId },
      data: { password_hash: await this.passwords.hash(newPassword), must_change_password: false },
    });
  }

  /** 남은 온보딩 항목 조회 (§8.5) */
  async onboardingStatus(userId: string): Promise<{ mustChangePassword: boolean; totpEnrollmentRequired: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { must_change_password: true, totp_enrollment_required: true },
    });
    return {
      mustChangePassword: user.must_change_password,
      totpEnrollmentRequired: user.totp_enrollment_required,
    };
  }

  /**
   * TOTP **최초 등록** 시작 — 온보딩 전용 (CR-1).
   *
   * 이 경로는 `totp_enrollment_required=true` 인 세션에서만 열린다. 등록을 마친 계정까지
   * 열어두면 **세션을 탈취한 공격자가 피해자의 2차 인증기를 자기 것으로 교체**할 수 있어
   * 2FA 의 존재 이유가 정확히 무력화된다(Phase 1 코드 리뷰 CR-1).
   * 사후 재등록은 재인증을 요구하는 `beginTotpReenrollment` 로 분리했다.
   */
  async beginTotpEnrollment(userId: string): Promise<{ keyUri: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totp_enrollment_required) {
      throw new ForbiddenException(
        '이미 2차 인증이 등록된 계정입니다. 재등록은 재인증이 필요합니다(POST /auth/2fa/reenroll).',
      );
    }
    const secret = this.totp.generateSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { totp_secret: secret } });
    return { keyUri: this.totp.keyUri(user.email, secret) };
  }

  /** TOTP 등록 확인 — 코드 검증 성공 시에만 totp_enrollment_required 해제 */
  async confirmTotpEnrollment(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.totp_secret || !this.totp.verify(user.totp_secret, code)) {
      throw new BadRequestException('TOTP 코드 불일치');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { totp_enrollment_required: false },
    });
  }

  // ── 2FA 재등록 (step-up 필요) — CR-1 ──────────────────────────
  /**
   * 재등록 시작. **현재 TOTP 코드 또는 비밀번호로 재인증(step-up)** 을 통과해야 한다.
   *
   * 새 시크릿을 `users.totp_secret` 에 즉시 쓰지 않고 **Redis 에 미확정 상태로 보관**한다.
   * 즉시 덮어쓰면 확인을 끝내지 않은 것만으로 피해자의 기존 인증기가 무효가 되어,
   * step-up 을 통과한 공격자가 "확인하지 않는 것"만으로 계정을 잠글 수 있다.
   * (users 테이블에 컬럼을 더하지 않는 이유이기도 하다 — INV-7)
   */
  async beginTotpReenrollment(
    userId: string,
    stepUp: { code?: string; password?: string },
  ): Promise<{ keyUri: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totp_enrollment_required || !user.totp_secret) {
      throw new BadRequestException('아직 최초 등록을 마치지 않은 계정입니다.');
    }

    const byCode = stepUp.code ? this.totp.verify(user.totp_secret, stepUp.code) : false;
    const byPassword = stepUp.password
      ? await this.passwords.verify(user.password_hash, stepUp.password)
      : false;
    if (!byCode && !byPassword) {
      // 어느 요소가 틀렸는지 구분해 알리지 않는다 — 유효한 요소를 좁혀주는 오라클이 된다
      throw new UnauthorizedException('재인증에 실패했습니다.');
    }

    const secret = this.totp.generateSecret();
    await this.redis.setEx(pendingTotpKey(userId), TOTP_REENROLL_TTL_SEC, secret);
    return { keyUri: this.totp.keyUri(user.email, secret) };
  }

  /** 재등록 확인 — 미확정 시크릿으로 검증에 성공한 뒤에야 실제 시크릿을 교체한다 */
  async confirmTotpReenrollment(userId: string, code: string): Promise<void> {
    const pending = await this.redis.get(pendingTotpKey(userId));
    if (!pending) {
      throw new BadRequestException('재등록 요청이 없거나 만료되었습니다. 처음부터 다시 시도하세요.');
    }
    if (!this.totp.verify(pending, code)) throw new BadRequestException('TOTP 코드 불일치');

    await this.prisma.user.update({ where: { id: userId }, data: { totp_secret: pending } });
    await this.redis.del(pendingTotpKey(userId));
  }
}
