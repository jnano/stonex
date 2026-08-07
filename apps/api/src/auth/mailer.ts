import { Injectable, Logger } from '@nestjs/common';

/**
 * 메일 발송 추상화 (기획서 §13.2 — 발송 수단 미결).
 * 결정 시 이 인터페이스의 구현만 교체하면 되므로 AUTH-1/4 구현이 결정을 기다리지 않는다.
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/** 개발·테스트용: 실제 발송 없이 로그로만 남긴다. 토큰 원문은 로그에 남기지 않는다 */
@Injectable()
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger(ConsoleMailer.name);

  async send(to: string, subject: string): Promise<void> {
    this.logger.log(`[개발 메일] to=${to} subject=${subject}`);
  }
}
