import { Injectable, Logger } from '@nestjs/common';

/**
 * 메일 발송 추상화 (기획서 §13.2 — 발송 수단 미결).
 * 결정 시 이 인터페이스의 구현만 교체하면 되므로 AUTH-1/4 구현이 결정을 기다리지 않는다.
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/**
 * 개발·테스트용: 실제 발송 없이 로그로만 남긴다.
 *
 * **본문(토큰 원문)은 기본적으로 남기지 않는다.** 로그는 수집기로 흘러가고 보존 기간이 길어,
 * 한 번 들어간 토큰은 회수하기 어렵기 때문이다.
 *
 * 다만 그러면 로컬 개발에서 이메일 확인·비밀번호 재설정 흐름을 끝까지 밟을 수 없다
 * (메일이 실제로 가지 않으므로 토큰을 얻을 데가 없다). 그래서 `DEV_MAIL_LOG_BODY=1` 일 때만
 * 본문을 함께 남긴다. **운영에서는 절대 켜지 않는다** — 켜는 순간 로그를 읽을 수 있는 사람이
 * 임의 계정의 비밀번호를 재설정할 수 있다.
 */
@Injectable()
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger(ConsoleMailer.name);
  private readonly logBody = process.env.DEV_MAIL_LOG_BODY === '1';

  async send(to: string, subject: string, body?: string): Promise<void> {
    const suffix = this.logBody && body ? ` body=${body}` : '';
    this.logger.log(`[개발 메일] to=${to} subject=${subject}${suffix}`);
    if (this.logBody) {
      this.logger.warn(
        'DEV_MAIL_LOG_BODY 가 켜져 있어 토큰 원문이 로그에 남습니다 — 운영에서는 반드시 끄십시오.',
      );
    }
  }
}
