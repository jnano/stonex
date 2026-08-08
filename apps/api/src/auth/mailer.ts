import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { SettingsService } from '../settings/settings.service';

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
 * 설정 기반 메일러 (범용 배포 지원).
 *
 * **발송 수단과 접속 정보를 DB 설정에서 읽는다.** 관리 화면에서 바꾸면 재기동 없이 반영되도록
 * 설정 세대(generation)를 보고 전송기를 다시 만든다 — 설정을 바꾸려고 서버를 내려야 한다면
 * 화면으로 옮긴 의미가 절반은 사라진다.
 *
 * `transport=console` 이면 실제 발송 없이 로그만 남긴다(개발 기본값).
 */
@Injectable()
export class ConfiguredMailer implements Mailer {
  private readonly logger = new Logger('Mailer');
  private transport: Transporter | null = null;
  private builtFor = -1;
  private builtWith = '';

  constructor(private readonly settings: SettingsService) {}

  async send(to: string, subject: string, body?: string): Promise<void> {
    const config = await this.settings.values('mail');
    const mode = config.transport ?? 'console';

    if (mode !== 'smtp') {
      // 본문(토큰)은 기본적으로 남기지 않는다. 로그는 보존이 길고 수집기로 흘러간다.
      const suffix = process.env.DEV_MAIL_LOG_BODY === '1' && body ? ` body=${body}` : '';
      this.logger.log(`[발송 안 함] to=${to} subject=${subject}${suffix}`);
      return;
    }

    const transport = this.transportFor(config);
    await transport.sendMail({
      from: config.from || config.user,
      to,
      subject,
      text: body ?? '',
    });
    this.logger.log(`메일 발송: to=${to} subject=${subject}`);
  }

  /** 설정이 바뀌었으면 전송기를 새로 만든다 */
  private transportFor(config: Record<string, string>): Transporter {
    const signature = `${config.host}:${config.port}:${config.user}`;
    if (this.transport && this.builtFor === this.settings.generation && this.builtWith === signature) {
      return this.transport;
    }
    if (!config.host || !config.user || !config.password) {
      // 조용히 성공하지 않는다 — "보낸 줄 알았는데 안 간" 상태가 가장 나쁘다
      throw new Error('메일 설정이 완료되지 않았습니다 (관리 › 시스템 설정에서 SMTP 를 입력하십시오).');
    }
    const port = Number(config.port || 465);
    this.transport = createTransport({
      host: config.host,
      port,
      secure: port === 465, // 465 는 암시적 TLS, 587 은 STARTTLS
      auth: { user: config.user, pass: config.password },
    });
    this.builtFor = this.settings.generation;
    this.builtWith = signature;
    return this.transport;
  }

  /** 연결 테스트 — 저장한 설정이 실제로 인증되는지 확인한다 */
  async verify(): Promise<void> {
    const config = await this.settings.values('mail');
    if ((config.transport ?? 'console') !== 'smtp') {
      throw new Error('발송 방식이 SMTP 가 아닙니다.');
    }
    await this.transportFor(config).verify();
  }
}
