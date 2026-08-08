import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { TotpService } from '../auth/totp.service';
import { MAILER, Mailer } from '../auth/mailer';
import { SubjectSnapshot } from '../authorization/types';

/** 확인 링크 수명. 짧게 두는 이유는 이 토큰이 곧 계정 식별자를 바꾸는 권한이기 때문이다 */
const CHANGE_TOKEN_TTL_MS = Number(process.env.EMAIL_CHANGE_TTL_MS ?? 60 * 60 * 1000);

export interface EmailChangeView {
  id: string;
  newEmail: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

/** 새 주소가 형식상 유효한가 — 서버가 보내는 메일이 반송되지 않을 최소 조건 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * 이메일(로그인 식별자) 변경 (기획서 §6.2 MEM-1 — "이메일 변경 시 재인증").
 *
 * 세 겹으로 막는다. 하나라도 빠지면 계정 탈취 경로가 된다.
 *  1. **재인증(step-up)**: 현재 TOTP 코드 또는 비밀번호. 세션만 탈취한 공격자가 주소를 바꾸면
 *     비밀번호 재설정 메일이 공격자에게 가서 계정을 통째로 가져간다(CR-1과 같은 구조).
 *  2. **새 주소 소유 확인**: 확인 전까지 `users.email` 은 그대로다. 즉시 반영하면 오타 하나로
 *     자기 계정에 들어갈 수 없게 된다.
 *  3. **기존 주소 통지**: 변경 사실을 옛 주소로도 알린다. 당사자가 탈취를 알아채는 유일한 신호다.
 */
@Injectable()
export class EmailChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly totp: TotpService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /**
   * 변경 요청. **원문 토큰은 반환하지 않고 새 주소로만 보낸다** —
   * 응답에 실으면 그 주소를 소유하지 않아도 확인을 마칠 수 있어 2단계가 무의미해진다.
   */
  async request(
    subject: SubjectSnapshot,
    input: { newEmail: string; stepUp: { code?: string; password?: string } },
  ): Promise<EmailChangeView> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: subject.id } });
    const newEmail = input.newEmail.trim().toLowerCase();

    if (!EMAIL_RE.test(newEmail) || newEmail.length > 255) {
      throw new BadRequestException('이메일 형식이 올바르지 않습니다.');
    }
    if (newEmail === user.email.toLowerCase()) {
      throw new BadRequestException('현재 사용 중인 주소와 같습니다.');
    }

    await this.verifyStepUp(user, input.stepUp);

    // 같은 테넌트에 이미 쓰이는 주소인지 본다. 확인 시점에 한 번 더 검사한다 —
    // 그 사이 다른 사람이 가입할 수 있고, 최종 판정은 유니크 제약이 한다.
    const taken = await this.prisma.user.findUnique({
      where: { tenant_id_email: { tenant_id: user.tenant_id, email: newEmail } },
    });
    if (taken) throw new ConflictException('이미 사용 중인 이메일입니다.');

    await this.expireStale(user.id);

    const raw = this.tokens.createOpaqueToken();
    const created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const pending = await tx.emailChangeRequest.findFirst({
        where: { user_id: user.id, status: 'PENDING' },
        select: { id: true },
      });
      if (pending) throw new ConflictException('이미 진행 중인 변경 요청이 있습니다.');

      const row = await tx.emailChangeRequest.create({
        data: {
          tenant_id: user.tenant_id,
          user_id: user.id,
          new_email: newEmail,
          token_hash: this.tokens.hash(raw),
          status: 'PENDING',
          expires_at: new Date(Date.now() + CHANGE_TOKEN_TTL_MS),
        },
      });
      // 새 주소는 detail 에 남긴다 — "누가 어디로 바꾸려 했는가"가 사후 추적의 핵심이다
      await this.audit.record(tx, {
        tenantId: user.tenant_id, actorId: user.id, action: 'member.email.change.request',
        targetType: 'user', targetId: user.id,
        detail: { before: { email: user.email }, after: { newEmail } },
      });
      return row;
    });

    await this.mailer.send(newEmail, '이메일 변경 확인', `확인 토큰: ${raw}`);
    // **옛 주소에도 알린다.** 본인이 하지 않은 변경이라면 이 메일이 유일한 경고다.
    await this.mailer.send(
      user.email,
      '이메일 변경이 요청되었습니다',
      `${newEmail} 로 변경이 요청되었습니다. 본인이 아니라면 즉시 비밀번호를 바꾸십시오.`,
    );
    return this.toView(created);
  }

  /**
   * 확인. 토큰을 가진 사람이 새 주소를 실제로 받았다는 뜻이므로 여기서 교체한다.
   * **전체 세션을 폐기한다** — 로그인 식별자가 바뀌었으므로, 탈취 세션이 있었다면 함께 끊는다.
   */
  async confirm(rawToken: string): Promise<void> {
    const record = await this.prisma.emailChangeRequest.findUnique({
      where: { token_hash: this.tokens.hash(rawToken) },
    });
    if (!record || record.status !== 'PENDING' || record.expires_at < new Date()) {
      throw new BadRequestException('유효하지 않거나 만료된 토큰입니다.');
    }

    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: record.user_id } });
    const previous = user.email;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // 요청 이후 다른 사람이 그 주소로 가입했을 수 있다 — 잠금 없이 읽고 넘어가면
      // 유니크 위반이 500 으로 새어 나간다
      const taken = await tx.user.findUnique({
        where: { tenant_id_email: { tenant_id: record.tenant_id, email: record.new_email } },
      });
      if (taken) throw new ConflictException('그 사이 다른 계정이 이 이메일을 사용하게 되었습니다.');

      await tx.user.update({ where: { id: user.id }, data: { email: record.new_email } });
      await tx.emailChangeRequest.update({
        where: { id: record.id },
        data: { status: 'CONFIRMED', confirmed_at: new Date() },
      });
      // 식별자가 바뀌었으므로 기존 세션을 전부 끊는다(비밀번호 재설정과 같은 처방)
      await tx.refreshToken.updateMany({
        where: { user_id: user.id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      await this.audit.record(tx, {
        tenantId: record.tenant_id, actorId: user.id, action: 'member.email.change.confirm',
        targetType: 'user', targetId: user.id,
        detail: { before: { email: previous }, after: { email: record.new_email } },
      });
    });

    await this.mailer.send(
      previous,
      '이메일이 변경되었습니다',
      `계정 이메일이 ${record.new_email} 로 변경되었습니다. 본인이 아니라면 즉시 문의하십시오.`,
    );
  }

  /** 본인이 요청을 거둬들인다 */
  async cancel(subject: SubjectSnapshot, requestId: string): Promise<void> {
    const record = await this.prisma.emailChangeRequest.findUnique({ where: { id: requestId } });
    if (!record || record.user_id !== subject.id) throw new NotFoundException();
    if (record.status !== 'PENDING') throw new ConflictException('이미 종료된 요청입니다.');

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.emailChangeRequest.update({
        where: { id: requestId }, data: { status: 'CANCELLED' },
      });
      await this.audit.record(tx, {
        tenantId: record.tenant_id, actorId: subject.id, action: 'member.email.change.cancel',
        targetType: 'user', targetId: subject.id,
        detail: { before: { newEmail: record.new_email, status: 'PENDING' }, after: { status: 'CANCELLED' } },
      });
    });
  }

  /** 내 진행 중 요청 (없으면 null) */
  async pending(subject: SubjectSnapshot): Promise<EmailChangeView | null> {
    await this.expireStale(subject.id);
    const row = await this.prisma.emailChangeRequest.findFirst({
      where: { user_id: subject.id, status: 'PENDING' },
    });
    return row ? this.toView(row) : null;
  }

  /**
   * 재인증 — CR-1 에서 TOTP 재등록에 붙인 것과 같은 규칙이다.
   * 어느 요소가 틀렸는지 구분해 알리지 않는다(유효한 요소를 좁혀 주는 오라클이 된다).
   */
  private async verifyStepUp(
    user: { password_hash: string; totp_secret: string | null },
    stepUp: { code?: string; password?: string },
  ): Promise<void> {
    const byCode = stepUp.code && user.totp_secret
      ? this.totp.verify(user.totp_secret, stepUp.code)
      : false;
    const byPassword = stepUp.password
      ? await this.passwords.verify(user.password_hash, stepUp.password)
      : false;
    if (!byCode && !byPassword) throw new UnauthorizedException('재인증에 실패했습니다.');
  }

  /** 만료된 PENDING 을 정리한다 — 부분 유니크가 재요청을 영구히 막지 않도록(도메인 이전과 동형) */
  private async expireStale(userId: string): Promise<void> {
    await this.prisma.emailChangeRequest.updateMany({
      where: { user_id: userId, status: 'PENDING', expires_at: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
  }

  private toView(row: {
    id: string; new_email: string; status: string; expires_at: Date; created_at: Date;
  }): EmailChangeView {
    return {
      id: row.id,
      newEmail: row.new_email,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    };
  }
}
