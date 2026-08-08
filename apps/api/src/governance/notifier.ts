import { Injectable, Logger } from '@nestjs/common';

export const GOVERNANCE_NOTIFIER = Symbol('GOVERNANCE_NOTIFIER');

export interface GovernanceAlert {
  /** PAGE = 즉시 호출, 나머지는 §14.4의 대응 단계 */
  level: 'PAGE' | 'L1' | 'L2' | 'L3';
  title: string;
  body: string;
  detail?: Record<string, unknown>;
}

export interface GovernanceNotifier {
  send(alert: GovernanceAlert): Promise<void>;
}

/**
 * 개발·테스트용 로그 어댑터.
 *
 * 운영에서는 webhook·이메일 어댑터로 교체한다 — 인터페이스만 지키면 순찰 코드는 그대로다.
 * **PAGE 는 error 레벨로 남긴다**: 로그 수집기의 경보 규칙이 보통 error 를 기준으로 걸리므로,
 * warn 으로 낮추면 시스템 잠금 위험이 조용히 지나간다.
 */
@Injectable()
export class LogGovernanceNotifier implements GovernanceNotifier {
  private readonly logger = new Logger('Governance');

  async send(alert: GovernanceAlert): Promise<void> {
    const line = `[${alert.level}] ${alert.title} — ${alert.body}`;
    if (alert.level === 'PAGE' || alert.level === 'L2') this.logger.error(line, alert.detail);
    else if (alert.level === 'L1') this.logger.warn(line, alert.detail);
    else this.logger.log(line, alert.detail);
  }
}
