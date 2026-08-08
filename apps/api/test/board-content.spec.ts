/**
 * 게시판 콘텐츠 파이프라인 단위 테스트 (WP-B2).
 *
 * 고정하는 계약:
 *  - **R-B2**: 위험 마크다운(<script>·이벤트 핸들러·javascript: 스킴)이 렌더에서
 *    무력화된다. 방어는 렌더 시점 — 원본(body_md)은 서비스가 그대로 보존한다
 *  - 이미지는 재인코딩을 통과해야 첨부다: EXIF 제거, 형식 위장 거부, 해상도 상한
 */
import sharp from 'sharp';
import { renderBodyHtml } from '../src/board/render';
import { isImageMime, reencodeImage } from '../src/board/image-guard';

describe('마크다운 파이프라인 (R-B2)', () => {
  it('<script> 는 실행 태그로 나가지 않는다', () => {
    const html = renderBodyHtml('본문 <script>alert(1)</script> 끝');
    expect(html).not.toContain('<script');
    expect(html).toContain('본문');
  });

  it('생 HTML 의 이벤트 핸들러는 실행 가능한 속성으로 나가지 않는다', () => {
    const html = renderBodyHtml('<img src="https://a.example/x.png" onerror="alert(1)">');
    // html:false 렌더러가 태그 전체를 텍스트로 이스케이프한다 — onerror 는 실행 불가한
    // 문자열(&quot;)로만 남는다. 실행 가능한 형태(<img …onerror=)가 없는 것이 계약이다.
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).not.toContain('onerror="');
  });

  it('javascript: 스킴은 href/src 속성으로 나가지 않는다', () => {
    const html = renderBodyHtml('[클릭](javascript:alert(1))');
    // 렌더러의 validateLink 가 링크 생성 자체를 거부한다(텍스트로만 남음) —
    // 새니타이저의 스킴 필터가 2차 방어로 겹친다
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toMatch(/<a[^>]*javascript:/);
  });

  it('마크다운 이미지의 비 http(s) 스킴은 새니타이저가 떨어뜨린다 (2차 방어)', () => {
    // markdown-it 은 data: 이미지의 렌더를 허용할 수 있다 — 새니타이저 스킴 필터가 잡는다
    const html = renderBodyHtml('![x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('src="data:');
  });

  it('정상 마크다운은 렌더된다 — 굵게·링크·코드', () => {
    const html = renderBodyHtml('**굵게** [링크](https://example.com) `코드`');
    expect(html).toContain('<strong>굵게</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<code>코드</code>');
  });
});

describe('이미지 보안 (WP-B2 §7.3)', () => {
  const pngBuffer = (w = 4, h = 4): Promise<Buffer> =>
    sharp({ create: { width: w, height: h, channels: 3, background: '#f00' } }).png().toBuffer();

  it('EXIF 가 재인코딩에서 제거된다', async () => {
    // EXIF(위치 정보 자리)를 실은 JPEG 를 만든 뒤 처리 결과에 없는지 실증
    const withExif = await sharp(await pngBuffer())
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-marker', Software: 'gps-here' } } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const clean = await reencodeImage(withExif, 'image/jpeg');
    expect((await sharp(clean).metadata()).exif).toBeUndefined();
  });

  it('선언 MIME 과 실제 바이트가 다르면 거부한다 (폴리글랏 위장)', async () => {
    const png = await pngBuffer();
    await expect(reencodeImage(png, 'image/jpeg')).rejects.toThrow(/형식과 실제 내용/);
    // 이미지가 아닌 바이트는 어떤 MIME 으로도 통과하지 못한다
    await expect(reencodeImage(Buffer.from('<script>x</script>'), 'image/png')).rejects.toThrow();
  });

  it('해상도 상한을 초과하면 거부한다 (픽셀 폭탄)', async () => {
    const wide = await sharp({
      create: { width: 9_000, height: 2, channels: 3, background: '#0f0' },
    }).png().toBuffer();
    await expect(reencodeImage(wide, 'image/png')).rejects.toThrow(/해상도/);
  });

  it('isImageMime — 이미지에만 재인코딩 경로가 걸린다', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
  });
});
