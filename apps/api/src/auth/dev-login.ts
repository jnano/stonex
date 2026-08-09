import { Body, Controller, Logger, Post } from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { Public } from '../authorization/decorators';
import { AuthService, TokenPair } from './auth.service';

/**
 * 개발 전용 로그인 (배포에 절대 포함되지 않는다).
 *
 * 왜 "인증 끄기"가 아니라 이 방식인가:
 * 인증을 끄고 주체를 주입하면 Guard·평가기·pv·온보딩 게이트가 전부 가짜로 동작해
 * **"개발에서는 됐는데 배포에서 안 되는"** 상태를 만든다. 여기서는 **실제 토큰**을
 * 발급하므로 이후 모든 경로가 운영과 동일하고, 우회되는 것은 비밀번호 확인 한 단계뿐이다.
 *
 * ── 배포 차단 4중 방어 (하나가 뚫려도 다음이 막는다) ──────────────────
 *  ① 이 컨트롤러는 `devLoginControllers()` 가 돌려줄 때만 등록된다 —
 *     조건 미충족이면 **라우트가 존재하지 않는다**(404, 인가 판정 이전)
 *  ② 활성 조건은 `DEV_LOGIN=1` **명시**다 — 기본값 없음. 잊어서 켜지는 일이 없다
 *  ③ `NODE_ENV=production` 이면 플래그가 있어도 등록하지 않는다
 *  ④ production + 플래그 조합은 **기동을 실패**시킨다(main.ts) — 조용히 무시하면
 *     "왜 안 되지" 로 끝나고, 다음 배포에 같은 설정이 또 실린다
 *
 * 사용 흔적은 경고 로그로 남긴다. 감사 로그는 남기지 않는다 — 개발 DB 의 감사 체인에
 * 운영에 없는 행위를 섞으면 체인 검증(RI-7)의 의미가 흐려진다.
 */
export class DevLoginDto {
  @IsEmail()
  email!: string;
}

@Controller('auth/dev')
export class DevLoginController {
  private readonly logger = new Logger('DevLogin');

  constructor(private readonly auth: AuthService) {}

  /**
   * 비밀번호 없이 해당 계정의 토큰을 발급한다. 계정은 **실재해야** 하고 상태 검사도
   * 그대로 받는다 — 없는 사용자를 만들어 주지 않는다(시드가 만든 계정으로 들어간다).
   */
  @Public()
  @Post('login')
  async devLogin(@Body() body: DevLoginDto): Promise<TokenPair> {
    this.logger.warn(`개발 전용 로그인 사용: ${body.email} (배포 환경에서는 이 경로가 존재하지 않습니다)`);
    return this.auth.devLogin(body.email);
  }
}

/** 개발 전용 로그인을 켤 조건 — 명시 플래그 + 비프로덕션 */
export function isDevLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEV_LOGIN === '1' && env.NODE_ENV !== 'production';
}

/**
 * 조건을 만족할 때만 컨트롤러를 돌려준다 — 등록 목록에 아예 넣지 않는 것이 1차 방어다.
 * 라우트가 없으면 인가 판정 이전에 404 이고, G-1 매트릭스에도 나타나지 않는다.
 */
export function devLoginControllers(env: NodeJS.ProcessEnv = process.env): [typeof DevLoginController] | [] {
  return isDevLoginEnabled(env) ? [DevLoginController] : [];
}

/**
 * production 에서 플래그가 켜져 있으면 기동을 막는다.
 * 조용히 무시하면 잘못된 설정이 그대로 다음 배포에도 실린다 — 여기서 드러낸다.
 */
export function assertDevLoginNotInProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.DEV_LOGIN === '1') {
    throw new Error(
      'DEV_LOGIN=1 은 프로덕션에서 사용할 수 없습니다. 배포 환경 변수에서 제거하십시오.',
    );
  }
}
