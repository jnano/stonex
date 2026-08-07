import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma 접속 제공자. 접속 URL은 환경 변수로만 주입한다(하드코딩 금지).
 * 권한 변경 트랜잭션은 반드시 this.$transaction 안에서 감사 기록(recordAudit)과 함께 수행한다(INV-6).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
