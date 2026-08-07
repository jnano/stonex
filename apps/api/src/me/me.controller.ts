import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedOnly } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';

/** GET /me 응답 — 프론트 표시 분기용 권한 스냅샷 (§8.4) */
interface MeResponse {
  id: string;
  status: string;
  roles: string[];
  permissions: Array<{ code: string; scope: string }>;
}

/**
 * 내 정보 + 권한 스냅샷 (기획서 §7.2, §8.4).
 *
 * 프론트는 이 값으로 메뉴·버튼 표시를 분기하되, **표시 분기는 UX 목적이며 보안 경계가 아니다**(§3).
 * 서버의 403/404 응답을 항상 처리해야 한다.
 * 내부 필드(password_hash, totp_secret 등)는 화이트리스트 방식으로 애초에 담지 않는다(§10.2).
 */
@Controller('me')
export class MeController {
  @AuthenticatedOnly()
  @Get()
  me(@Req() req: AuthedRequest): MeResponse {
    const subject = req.subject;
    if (!subject) throw new UnauthorizedException();
    return {
      id: subject.id,
      status: subject.status,
      roles: subject.roles,
      permissions: [...subject.permissions].map(([code, scope]) => ({ code, scope })),
    };
  }
}
