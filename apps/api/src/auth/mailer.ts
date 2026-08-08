import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

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

/**
 * SMTP 발송 어댑터 (§13.2 결정: 개발 단계는 Gmail SMTP).
 *
 * **운영 전환 시 이 클래스만 교체하거나 접속 정보만 바꾸면 된다** — 인터페이스가 같기 때문이다.
 * Gmail 은 일일 발송 한도와 스팸 분류 위험이 있어 운영에는 부적합하다는 것을 전제로 고른
 * 선택이며, 리얼 발송 흐름을 먼저 확인하려는 목적이다.
 *
 * 접속 정보는 전부 환경 변수다(하드코딩 금지). Gmail 은 **앱 비밀번호**를 발급받아 써야 하며
 * 계정 비밀번호로는 인증되지 않는다.
 */
@Injectable()
export class SmtpMailer implements Mailer, OnModuleInit {
  private readonly logger = new Logger(SmtpMailer.name);
  private transport: Transporter | null = null;

  onModuleInit(): void {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    if (!host || !user || !pass) {
      // 기동을 막지는 않는다 — 메일이 필요 없는 경로(관리 API 등)까지 함께 죽으면
      // 설정 하나가 서비스 전체를 세우는 셈이 된다. 대신 발송 시점에 명확히 실패한다.
      this.logger.error('SMTP 설정이 없습니다 (SMTP_HOST/USER/PASSWORD). 메일 발송이 실패합니다.');
      return;
    }
    const port = Number(process.env.SMTP_PORT ?? 465);
    this.transport = createTransport({
      host,
      port,
      secure: port === 465, // 465 는 암시적 TLS, 587 은 STARTTLS
      auth: { user, pass },
    });
  }

  async send(to: string, subject: string, body?: string): Promise<void> {
    if (!this.transport) {
      throw new Error('SMTP 설정이 없어 메일을 보낼 수 없습니다.');
    }
    await this.transport.sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to,
      subject,
      text: body ?? '',
    });
    // **본문은 로그에 남기지 않는다** — 토큰이 그대로 들어 있다.
    this.logger.log(`메일 발송: to=${to} subject=${subject}`);
  }
}
