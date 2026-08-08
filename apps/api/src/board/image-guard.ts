import sharp, { type FormatEnum, type Metadata } from 'sharp';
import { BadRequestException } from '@nestjs/common';

/**
 * 이미지 보안 처리 (WP-B2, 스펙 §7.3).
 *
 * 업로드된 이미지는 **재인코딩**을 통과해야 첨부가 된다:
 *  - EXIF·메타데이터 제거 — 위치 정보 등 개인정보가 원본에 실려 오는 것을 차단
 *  - 선언 MIME 과 실제 바이트의 이중검증 — 확장자 위장(폴리글랏) 차단.
 *    sharp 가 디코드하지 못하면 그 바이트는 이미지가 아니다
 *  - 해상도 상한 — 픽셀 폭탄(decompression bomb) 차단
 *
 * 재인코딩은 원본 바이트를 버리고 디코드된 픽셀에서 새로 만든다 — 이미지에 숨긴
 * 실행 페이로드는 픽셀이 아니므로 살아남지 못한다.
 */

const MAX_DIMENSION = 8_192; // px — 초과분은 축소가 아니라 거부(의도 왜곡 방지)

const IMAGE_MIME: Record<string, keyof FormatEnum> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function isImageMime(mime: string): boolean {
  return mime in IMAGE_MIME;
}

export async function reencodeImage(input: Buffer, declaredMime: string): Promise<Buffer> {
  const format = IMAGE_MIME[declaredMime];
  if (!format) throw new BadRequestException('지원하지 않는 이미지 형식입니다.');

  let meta: Metadata;
  try {
    meta = await sharp(input, { animated: format === 'gif' }).metadata();
  } catch {
    throw new BadRequestException('이미지를 해석할 수 없습니다 — 선언된 형식과 실제 내용이 다릅니다.');
  }
  // 선언 MIME ↔ 실제 바이트 이중검증 (jpg 를 png 로 선언하는 위장 차단)
  const actual = String(meta.format) === 'jpg' ? 'jpeg' : meta.format;
  if (actual !== format) {
    throw new BadRequestException('이미지를 해석할 수 없습니다 — 선언된 형식과 실제 내용이 다릅니다.');
  }
  if ((meta.width ?? 0) > MAX_DIMENSION || (meta.height ?? 0) > MAX_DIMENSION) {
    throw new BadRequestException(`이미지 해상도가 상한(${MAX_DIMENSION}px)을 초과합니다.`);
  }

  // rotate(): EXIF Orientation 을 픽셀에 적용한 뒤 메타데이터를 버린다 —
  // 제거만 하면 사진이 눕는다. withMetadata() 를 부르지 않으므로 EXIF 는 실리지 않는다.
  return sharp(input, { animated: format === 'gif' }).rotate().toFormat(format as keyof FormatEnum).toBuffer();
}
