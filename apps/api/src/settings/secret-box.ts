import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 설정 비밀값 암호화 (AES-256-GCM).
 *
 * **열쇠는 DB 밖에 둔다.** 같은 DB에 두면 자물쇠 옆에 열쇠를 두는 셈이라, DB 백업 하나가
 * 유출되는 순간 SMTP·스토리지 자격 증명이 함께 나간다.
 *
 * GCM 을 쓰는 이유는 **변조 탐지**다. 평범한 CBC 라면 암호문 조작을 알아챌 수 없고,
 * 설정값은 그 자체가 접속 대상을 정하므로(엔드포인트 바꿔치기) 무결성이 기밀성만큼 중요하다.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM 권장 길이

export class SecretBoxError extends Error {}

function loadKey(): Buffer {
  const raw = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!raw) {
    throw new SecretBoxError(
      'SETTINGS_ENCRYPTION_KEY 가 필요합니다. ' +
        '`openssl rand -base64 32` 로 생성해 환경 변수로 주입하십시오.',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    // 짧은 키를 조용히 받아들이면 암호화는 되지만 강도가 무너진다
    throw new SecretBoxError('SETTINGS_ENCRYPTION_KEY 는 base64 로 인코딩한 32바이트여야 합니다.');
  }
  return key;
}

/** 저장 형식: `iv.tag.ciphertext` (각각 base64) */
export function seal(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

export function open(sealed: string): string {
  const key = loadKey();
  const [ivB64, tagB64, dataB64] = sealed.split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new SecretBoxError('암호문 형식이 올바르지 않습니다.');

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // 열쇠가 바뀌었거나 암호문이 변조된 경우다. 둘을 구분해 알려주지 않는다.
    throw new SecretBoxError(
      '설정 비밀값을 복호화할 수 없습니다. 암호화 키가 바뀌었거나 값이 손상되었습니다.',
    );
  }
}

/** 키가 준비돼 있는지 — 기동 점검·화면 안내용 */
export function isKeyConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
