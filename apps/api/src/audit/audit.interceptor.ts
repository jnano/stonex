import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedRequest } from '../authorization/guards/auth.guard';

/** 접근 로그를 남길 HTTP 메서드 — 비변경(조회) 요청만 */
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * 접근 로그 인터셉터 (기획서 §7.4 [6]) — **조회·비변경 행위 전용**.
 *
 * 권한 변경(역할 부여/회수, 매핑 편집, Grant 생성/회수, 정지/삭제)의 감사는 절대 여기서 하지 않는다.
 * 인터셉터 시점에는 핸들러 트랜잭션이 이미 커밋되어 있어 "기록 실패 시 롤백"(INV-6)이 성립하지 않기 때문이다.
 * 그런 기록은 서비스 계층에서 recordAudit(tx, ...) 로 수행한다(WP-6a).
 *
 * 또한 접근 로그 기록 실패가 조회 응답을 실패시키지 않는다 — 실패는 삼키되 서버 로그로 남긴다.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!READ_METHODS.has(request.method)) return next.handle();

    return next.handle().pipe(
      tap(() => {
        const subject = request.subject;
        if (!subject) return; // 비인증 공개 조회는 접근 로그 대상이 아니다
        void this.record(subject.tenantId, subject.id, request.method, request.path, request.ip);
      }),
    );
  }

  private async record(
    tenantId: string,
    actorId: string,
    method: string,
    path: string,
    ip: string | undefined,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        INSERT INTO audit.audit_logs (tenant_id, actor_id, action, target_type, detail, ip_address)
        VALUES (
          ${tenantId}::uuid, ${actorId}::uuid, 'access.read', 'http',
          ${JSON.stringify({ method, path })}::jsonb, ${ip ?? null}::inet
        )`;
    } catch (error) {
      // 접근 로그 실패는 조회를 막지 않는다 (INV-6 적용 대상이 아님)
      console.error('접근 로그 기록 실패', error);
    }
  }
}
