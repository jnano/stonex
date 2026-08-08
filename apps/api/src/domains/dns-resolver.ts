import { Injectable, Logger } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';

/**
 * DNS TXT 조회기 (WP-12, DOM-3).
 *
 * **인터페이스로 분리하는 이유는 두 가지다.** ① 테스트에서 실제 DNS 를 때리지 않고 교체할 수
 * 있어야 하고, ② 기획서 §13.2 의 미결 항목("HTML 파일 업로드 방식 병행 여부")이 결정되면
 * 같은 자리에 다른 구현을 끼워 검증 서비스를 그대로 재사용하기 위해서다.
 */
export const DNS_TXT_RESOLVER = Symbol('DNS_TXT_RESOLVER');

export interface DnsTxtResolver {
  /** 해당 FQDN 의 TXT 레코드 전체. 조회 실패·부재는 예외가 아니라 빈 배열로 돌려준다 */
  resolveTxt(fqdn: string): Promise<string[]>;
}

/** 어댑터 계약 (작업지시서 WP-12-2 운영 검토) — 상수는 여기 한 곳에만 둔다 */
export const DNS_TIMEOUT_MS = Number(process.env.DOMAIN_DNS_TIMEOUT_MS ?? 3000);
export const DNS_RETRIES = Number(process.env.DOMAIN_DNS_RETRIES ?? 1);
export const DNS_CACHE_TTL_MS = Number(process.env.DOMAIN_DNS_CACHE_TTL_MS ?? 60_000);

@Injectable()
export class NodeDnsTxtResolver implements DnsTxtResolver {
  private readonly logger = new Logger(NodeDnsTxtResolver.name);
  private readonly cache = new Map<string, { records: string[]; expiresAt: number }>();

  async resolveTxt(fqdn: string): Promise<string[]> {
    const cached = this.cache.get(fqdn);
    if (cached && cached.expiresAt > Date.now()) return cached.records;

    let records: string[] = [];
    for (let attempt = 0; attempt <= DNS_RETRIES; attempt += 1) {
      const result = await this.queryOnce(fqdn);
      if (result !== null) {
        records = result;
        break;
      }
    }
    // 실패(null)도 빈 배열로 캐시한다 — 존재하지 않는 도메인을 반복 조회해 상위 리졸버를
    // 두드리는 것을 막는다. TTL 이 60초라 사용자가 DNS 를 고친 뒤 오래 기다리지 않는다.
    this.cache.set(fqdn, { records, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
    return records;
  }

  /** 1회 조회. 성공 시 레코드 배열, 실패·타임아웃 시 null */
  private async queryOnce(fqdn: string): Promise<string[] | null> {
    // 조회마다 Resolver 인스턴스를 새로 만든다 — cancel() 이 그 인스턴스의 진행 중 질의만
    // 취소하므로, 공유 인스턴스를 쓰면 한 도메인의 타임아웃이 다른 조회를 함께 끊는다.
    const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS });
    let timer: NodeJS.Timeout | undefined;
    try {
      // Resolver 의 timeout 옵션은 질의 단위라 재시도까지 포함한 총 시간을 보장하지 않는다.
      // **경성 상한은 여기서 건다** — DOM-3 의 "3초 내 응답" 은 이 race 가 보장한다.
      const chunks = await Promise.race([
        resolver.resolveTxt(fqdn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            resolver.cancel();
            reject(new Error('DNS 조회 시간 초과'));
          }, DNS_TIMEOUT_MS);
        }),
      ]);
      // TXT 는 255바이트 단위로 쪼개져 오므로 레코드별로 이어 붙인다
      return chunks.map((parts) => parts.join(''));
    } catch (error) {
      this.logger.debug(`TXT 조회 실패 ${fqdn}: ${(error as Error).message}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
