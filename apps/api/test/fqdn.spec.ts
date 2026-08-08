/**
 * FQDN 정규화 단위 테스트 (WP-12).
 *
 * 정규화는 DB 의 부분 유니크 `uq_domains_fqdn_live` 가 실제로 중복을 막아 주는 전제다.
 * 여기가 새면 **같은 도메인이 두 행으로 등록되어 두 사람이 각각 VERIFIED 를 얻는다** —
 * 그 순간부터 위임·이전이 어느 행에 걸렸는지가 갈린다.
 */
import { normalizeFqdn, txtRecordValue } from '../src/domains/fqdn';

describe('normalizeFqdn', () => {
  it('대소문자·후행 점·주변 공백이 하나의 정규형으로 모인다', () => {
    const forms = ['example.com', 'EXAMPLE.com', 'Example.COM', 'example.com.', '  example.com  '];
    for (const form of forms) expect(normalizeFqdn(form)).toBe('example.com');
  });

  it('IDN(유니코드 도메인)은 punycode 로 변환된다', () => {
    // 정규화하지 않으면 같은 도메인의 한글 표기와 punycode 표기가 별개 행이 된다
    expect(normalizeFqdn('한국.kr')).toBe(normalizeFqdn(normalizeFqdn('한국.kr')));
    expect(normalizeFqdn('한국.kr').startsWith('xn--')).toBe(true);
  });

  it('서브도메인은 보존된다', () => {
    expect(normalizeFqdn('WWW.Sub.Example.com')).toBe('www.sub.example.com');
  });

  it('형식이 잘못된 입력은 거부된다', () => {
    const bad = [
      '', '   ', 'example', // TLD 없음
      'exa mple.com', // 공백
      '-example.com', 'example-.com', // 라벨 경계 하이픈
      'example..com', // 빈 라벨
      '192.168.0.1', // 숫자 TLD — IP 문자열이 도메인으로 등록되는 것을 막는다
      'http://example.com', // 스킴 포함
      `${'a'.repeat(64)}.com`, // 라벨 63자 초과
    ];
    for (const input of bad) {
      expect(() => normalizeFqdn(input)).toThrow();
    }
  });

  it('253자를 넘는 도메인은 거부된다', () => {
    const long = `${Array.from({ length: 10 }, () => 'a'.repeat(30)).join('.')}.com`;
    expect(long.length).toBeGreaterThan(253);
    expect(() => normalizeFqdn(long)).toThrow();
  });

  it('TXT 값에는 서비스 접두어가 붙는다 (다른 서비스 토큰과의 우연한 일치 방지)', () => {
    expect(txtRecordValue('abc')).toBe('stonex-site-verification=abc');
  });
});
