/** 미선언 엔드포인트 기동 차단 테스트 — WP-3 DoD (§7.3) */
import { Controller, Get, Post } from '@nestjs/common';
import { Public, RequirePermission } from '../src/authorization/decorators';
import { enforceEndpointDeclarations, findUndeclaredEndpoints } from '../src/authorization/startup-check';
import { CONTROLLERS } from '../src/app.controllers';

@Controller('declared')
class DeclaredController {
  @Public()
  @Get()
  open(): string { return 'ok'; }

  @RequirePermission('member.read')
  @Get('members')
  list(): string { return 'ok'; }
}

@Controller('undeclared')
class UndeclaredController {
  @Get()
  oops(): string { return 'leak'; }

  @Post('write')
  alsoOops(): string { return 'leak'; }

  // 라우트가 아닌 일반 메서드는 검사 대상이 아니다
  helper(): string { return 'x'; }
}

describe('미선언 엔드포인트 기동 차단 (§7.3)', () => {
  it('선언 완료 컨트롤러는 통과한다', () => {
    expect(findUndeclaredEndpoints([DeclaredController])).toEqual([]);
    expect(() => enforceEndpointDeclarations([DeclaredController])).not.toThrow();
  });

  it('미선언 라우트가 있으면 전부 지목하며 기동이 실패한다', () => {
    const violations = findUndeclaredEndpoints([UndeclaredController]);
    expect(violations).toEqual(['UndeclaredController.oops', 'UndeclaredController.alsoOops']);
    expect(() => enforceEndpointDeclarations([UndeclaredController])).toThrow(/미선언/);
  });

  it('실제 앱의 전 컨트롤러가 선언을 충족한다 (G-5와 동일 검사)', () => {
    expect(findUndeclaredEndpoints(CONTROLLERS)).toEqual([]);
  });
});
