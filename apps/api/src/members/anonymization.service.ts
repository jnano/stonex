import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/** 탈퇴 후 개인정보 파기까지의 유예 (§13.2 결정: 30일) */
const RETENTION_DAYS = Number(process.env.MEMBER_ANONYMIZE_AFTER_DAYS ?? 30);
/**
 * 한 번에 처리할 최대 인원.
 * 익명화는 **되돌릴 수 없다.** 기준일 계산이 잘못되면 한 번에 전 회원이 지워질 수 있으므로,
 * 그런 사고를 하루치 피해로 묶어 두고 나머지는 다음 실행으로 넘긴다(순찰의 blast-radius 와 같은 취지).
 */
const BATCH_LIMIT = Number(process.env.MEMBER_ANONYMIZE_BATCH ?? 200);

/** 익명화된 계정의 이메일 형태 — 이 패턴 자체가 "이미 처리됨" 표식이다 */
const anonymizedEmail = (userId: string): string => `deleted-${userId}@invalid.local`;
const ANONYMIZED_NAME = '탈퇴한 회원';

export interface AnonymizationReport {
  processed: number;
  remaining: number;
  cutoff: string;
}

/**
 * 탈퇴 회원 개인정보 파기 (§13.2 결정 — 30일 후 익명화).
 *
 * **행을 지우지 않고 식별 정보만 지운다.** 계정 행을 물리 삭제하면 감사 로그의 `actor_id` 가
 * 가리킬 대상이 사라져 "누가 무엇을 했는가"를 영구히 잃는다 — 그 기록은 법적 의무이자
 * §14 거버넌스의 근거다. 이름·이메일 같은 식별 정보만 걷어내면 개인정보 파기 의무와
 * 추적 가능성이 양립한다.
 *
 * **새 컬럼을 더하지 않는다**(INV-7). 익명화 여부는 이메일 패턴으로 판별하며, 그 값이
 * `user_id` 기반이라 `UNIQUE(tenant_id, email)` 과도 충돌하지 않는다.
 */
@Injectable()
export class MemberAnonymizationService {
  private readonly logger = new Logger(MemberAnonymizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 매일 04:10 */
  @Cron('10 4 * * *')
  async daily(): Promise<void> {
    try {
      const report = await this.run();
      if (report.processed > 0) {
        this.logger.log(`탈퇴 회원 익명화 ${report.processed}명 (남은 대상 ${report.remaining}명)`);
      }
    } catch (error) {
      // 파기가 멎으면 개인정보가 계속 남는다 — 조용히 넘기지 않는다
      this.logger.error('탈퇴 회원 익명화 배치 실패', error);
      throw error;
    }
  }

  async run(now = new Date()): Promise<AnonymizationReport> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // 아직 익명화되지 않은 대상만 고른다. 패턴 판별이라 재실행해도 안전하다(멱등).
    const targets = await this.prisma.user.findMany({
      where: {
        deleted_at: { not: null, lt: cutoff },
        NOT: { email: { endsWith: '@invalid.local' } },
      },
      select: { id: true, tenant_id: true, email: true },
      take: BATCH_LIMIT,
      orderBy: { deleted_at: 'asc' },
    });

    for (const user of targets) {
      await this.anonymize(user);
    }

    const remaining = await this.prisma.user.count({
      where: {
        deleted_at: { not: null, lt: cutoff },
        NOT: { email: { endsWith: '@invalid.local' } },
      },
    });
    return { processed: targets.length, remaining, cutoff: cutoff.toISOString() };
  }

  private async anonymize(user: { id: string; tenant_id: string; email: string }): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          email: anonymizedEmail(user.id),
          name: ANONYMIZED_NAME,
          // 인증 수단을 무효화한다. 빈 문자열이 아니라 검증이 반드시 실패하는 값을 넣는다 —
          // 빈 값은 해시 검증 구현에 따라 통과할 여지를 남긴다.
          password_hash: 'anonymized',
          totp_secret: null,
          totp_enrollment_required: false,
          must_change_password: false,
        },
      });
      // 남아 있는 세션·토큰도 함께 정리한다. 식별 정보를 지우면서 그 계정으로 들어올 수 있는
      // 통로를 남겨 두면 파기가 반쪽이 된다.
      await tx.refreshToken.deleteMany({ where: { user_id: user.id } });
      await tx.verificationToken.deleteMany({ where: { user_id: user.id } });

      // **감사에는 남긴다.** 다만 지워진 원본 이메일을 detail 에 담지 않는다 —
      // 그러면 감사 로그가 파기 대상 정보를 그대로 보관하는 우회로가 된다.
      await this.audit.record(tx, {
        tenantId: user.tenant_id,
        actorId: null, // 시스템 행위
        action: 'member.anonymize',
        targetType: 'user',
        targetId: user.id,
        detail: {
          before: { anonymized: false },
          after: { anonymized: true, retentionDays: RETENTION_DAYS },
        },
      });
    });
  }
}
