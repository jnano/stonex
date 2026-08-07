import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { checkDominance } from '../dominance';
import { DOMINANCE_META } from '../decorators';
import { SnapshotService } from '../snapshot.service';
import { AuthedRequest } from './auth.guard';

/**
 * 우위 검사 Guard (§7.4 [4], §4.6-1).
 * @RequireDominance 가 선언된 관리 행위 라우트에서 행위자 집합 ⊋ 대상자 집합을 검사한다.
 * 부분집합 검사(§4.6-2, 역할 부여 시 역할 집합 ⊆ 행위자 집합)는 대상 역할이 요청 본문에
 * 있으므로 Guard 가 아닌 서비스 계층에서 checkRoleSubset 으로 수행한다(WP-5).
 */
@Injectable()
export class DominanceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly snapshots: SnapshotService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.get<{ targetParam: string } | undefined>(
      DOMINANCE_META,
      context.getHandler(),
    );
    if (!meta) return true; // 관리 행위 선언이 없는 라우트는 통과

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const subject = request.subject;
    if (!subject) throw new ForbiddenException();

    const raw = request.params[meta.targetParam];
    const targetId = Array.isArray(raw) ? raw[0] : raw;
    if (!targetId) throw new ForbiddenException();
    const target = await this.snapshots.forUser(targetId);
    if (!target) throw new ForbiddenException(); // 대상 부재 — 관리 행위이므로 404 은닉 불요(§7.1)

    const result = checkDominance(
      subject.id,
      new Set(subject.permissions.keys()),
      target.id,
      new Set(target.permissions.keys()),
    );
    if (!result.allowed) throw new ForbiddenException();
    return true;
  }
}
