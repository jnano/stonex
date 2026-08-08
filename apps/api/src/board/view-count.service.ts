import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 조회수 (기능모듈 view-count — WP-B4, 스펙 §8.3·R-B14).
 *
 * **요청 경로에서 DB 를 쓰지 않는다** — 조회마다 UPDATE(또는 outbox INSERT 조차)를 하면
 * 읽기 트래픽이 그대로 쓰기 부하로 전이된다. 조회는 인메모리 버퍼에 세고, 주기 플러시가
 * 증분(increment)으로 반영한다. 멀티 인스턴스여도 각자 자기 버퍼만 더하므로 유실 없이
 * 합산된다. 인스턴스가 죽으면 마지막 플러시 이후 분은 사라진다 — 조회수는 통계이지
 * 원장이 아니므로 감수한다(정확성보다 요청 경로 무부하가 계약).
 */
@Injectable()
export class ViewCountService {
  private readonly logger = new Logger(ViewCountService.name);
  private buffer = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** 조회 경로에서 호출 — 메모리 증가뿐, I/O 없음 */
  bump(postId: string): void {
    this.buffer.set(postId, (this.buffer.get(postId) ?? 0) + 1);
  }

  @Interval(15_000)
  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;
    const batch = this.buffer;
    this.buffer = new Map(); // 스왑 — 플러시 중 새 조회는 다음 배치로
    try {
      for (const [postId, count] of batch) {
        await this.prisma.$executeRaw`
          UPDATE posts SET view_count = view_count + ${count} WHERE id = ${postId}::uuid`;
      }
    } catch (error) {
      // 플러시 실패분은 버퍼로 되돌린다 — 다음 주기에 재시도(증분이라 중복 없음)
      for (const [postId, count] of batch) {
        this.buffer.set(postId, (this.buffer.get(postId) ?? 0) + count);
      }
      this.logger.error(`조회수 플러시 실패: ${(error as Error).message}`);
    }
  }
}
