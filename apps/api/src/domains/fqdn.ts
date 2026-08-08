import { BadRequestException } from '@nestjs/common';
import { domainToASCII } from 'node:url';

/**
 * FQDN 정규화·검증 (WP-12).
 *
 * **입력을 정규형으로 바꿔 저장하는 것이 중복 방지의 실질이다.** DB 의 부분 유니크
 * `uq_domains_fqdn_live` 는 바이트 단위 비교라, 정규화 없이 저장하면 `EXAMPLE.com`·
 * `example.com.`·한글 도메인이 모두 별개의 행이 된다. 그러면 중복 방지가 무력화되고
 * **같은 도메인을 두 사람이 각각 VERIFIED 로 만들 수 있다** — 소유권 판정이 갈리는 순간
 * 위임(DOM-5)·이전(DOM-6)이 어느 행에 걸렸는지도 함께 갈린다.
 *
 * 정규형 = 소문자 + 후행 점 제거 + punycode(IDN → `xn--`).
 * 원문은 보관하지 않는다. 표시용 원문을 따로 두면 "보이는 도메인"과 "검증된 도메인"이
 * 달라질 수 있어, 그 자체가 표시 위조 경로가 된다.
 */

/** 라벨: 영숫자로 시작·끝나고 내부에 하이픈 허용, 1~63자 */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** 최상위 라벨은 숫자로만 이뤄질 수 없다 (IP 주소 문자열이 도메인으로 등록되는 것을 막는다) */
const TLD_RE = /^([a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

export function normalizeFqdn(input: string): string {
  const trimmed = input.trim().replace(/\.+$/, ''); // 후행 점(루트 표기) 제거
  if (trimmed.length === 0) throw new BadRequestException('도메인을 입력하세요.');

  // domainToASCII 는 소문자화·NFC 정규화·punycode 변환을 한 번에 수행한다(WHATWG URL 표준).
  // 변환 불가 입력에는 빈 문자열을 반환하므로, 그 자체가 형식 검증이 된다.
  const ascii = domainToASCII(trimmed);
  if (ascii.length === 0) throw new BadRequestException('도메인 형식이 올바르지 않습니다.');
  if (ascii.length > 253) throw new BadRequestException('도메인이 너무 깁니다(최대 253자).');

  const labels = ascii.split('.');
  if (labels.length < 2) {
    throw new BadRequestException('최상위 도메인을 포함한 전체 도메인을 입력하세요(예: example.com).');
  }
  for (const label of labels) {
    if (!LABEL_RE.test(label)) {
      throw new BadRequestException(`도메인 구성이 올바르지 않습니다: ${label}`);
    }
  }
  if (!TLD_RE.test(labels[labels.length - 1])) {
    throw new BadRequestException('최상위 도메인이 올바르지 않습니다.');
  }
  return ascii;
}

/**
 * DNS TXT 로 게시해야 할 레코드 값.
 * 접두어를 붙여, 다른 서비스의 검증 토큰이 우연히 일치하는 일이 없게 한다.
 */
export function txtRecordValue(token: string): string {
  return `stonex-site-verification=${token}`;
}
