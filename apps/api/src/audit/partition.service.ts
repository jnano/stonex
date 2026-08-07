import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 감사 로그 월 파티션 자동 생성 (기획서 §5.2, db/README.md).
 *
 * 익월 파티션이 없으면 월말 자정에 INSERT 가 실패하고, INV-6 규칙상 그 순간
 * 모든 권한 변경 트랜잭션이 롤백된다 — 즉 파티션 누락은 서비스 중단으로 직결된다.
 * 따라서 (a) 매일 새벽 배치로 익월 파티션을 선생성하고, (b) 기동 시에도 1회 보증한다.
 */
@Injectable()
export class AuditPartitionService {
  private readonly logger = new Logger(AuditPartitionService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 당월·익월 파티션 보증 (존재하면 무시) */
  async ensurePartitions(): Promise<void> {
    await this.prisma.$executeRaw`SELECT audit.create_partition(now()::date)`;
    await this.prisma.$executeRaw`SELECT audit.create_partition((now() + interval '1 month')::date)`;
  }

  async onModuleInit(): Promise<void> {
    await this.guarded('기동 시');
  }

  /** 매일 03:10 — 월말·타임존 경계에서도 익월 파티션이 항상 존재하도록 */
  @Cron('10 3 * * *')
  async daily(): Promise<void> {
    await this.guarded('일일 배치');
  }

  private async guarded(label: string): Promise<void> {
    try {
      await this.ensurePartitions();
    } catch (error) {
      // 실패를 삼키면 월말에 서비스가 멈춘다 — 반드시 error 로그로 남겨 알림에 걸리게 한다
      this.logger.error(`감사 로그 파티션 생성 실패 (${label}) — 익월 기록이 중단될 수 있습니다`, error);
    }
  }
}
