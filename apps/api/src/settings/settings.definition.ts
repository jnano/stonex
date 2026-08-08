/**
 * 설정 항목 정의 — **화면·검증·저장의 유일한 출처**.
 *
 * 항목을 여기 한 곳에만 적으면 새 설정이 늘어도 화면 코드를 손댈 필요가 없고,
 * "화면에는 있는데 저장되지 않는" 류의 어긋남이 생기지 않는다(§15.1).
 */

export type SettingKind = 'text' | 'number' | 'secret' | 'select';

export interface SettingField {
  key: string;
  label: string;
  kind: SettingKind;
  /** 설명 — 화면에 그대로 표시된다 */
  hint?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export interface SettingCategory {
  category: string;
  label: string;
  description: string;
  fields: SettingField[];
  /** 연결 테스트를 지원하는가 */
  testable: boolean;
}

export const SETTING_CATEGORIES: SettingCategory[] = [
  {
    category: 'mail',
    label: '메일 발송',
    description:
      '가입 인증·비밀번호 재설정·이메일 변경 확인 메일을 보내는 경로입니다. ' +
      '설정하지 않으면 이 기능들이 동작하지 않습니다.',
    testable: true,
    fields: [
      {
        key: 'transport',
        label: '발송 방식',
        kind: 'select',
        required: true,
        options: [
          { value: 'console', label: '보내지 않음 (서버 로그에만 기록)' },
          { value: 'smtp', label: 'SMTP 서버로 발송' },
        ],
        hint: '"보내지 않음"은 개발용입니다. 운영에서는 SMTP 를 쓰십시오.',
      },
      { key: 'host', label: 'SMTP 호스트', kind: 'text', placeholder: 'smtp.gmail.com' },
      { key: 'port', label: '포트', kind: 'number', placeholder: '465', hint: '465=SSL, 587=STARTTLS' },
      { key: 'user', label: '사용자', kind: 'text', placeholder: 'sender@example.com' },
      {
        key: 'password',
        label: '비밀번호',
        kind: 'secret',
        hint: 'Gmail 은 계정 비밀번호가 아니라 **앱 비밀번호**를 발급받아 넣습니다.',
      },
      {
        key: 'from',
        label: '보내는 사람',
        kind: 'text',
        placeholder: 'stonex <sender@example.com>',
        hint: '비워두면 사용자 주소를 씁니다.',
      },
    ],
  },
  {
    category: 'storage',
    label: '파일 저장소',
    description:
      'S3 호환 오브젝트 스토리지입니다. MinIO·AWS S3·네이버 클라우드 등 같은 규격이면 ' +
      '엔드포인트만 바꿔 쓸 수 있습니다.',
    testable: true,
    fields: [
      {
        key: 'endpoint',
        label: '엔드포인트',
        kind: 'text',
        placeholder: 'http://127.0.0.1:9000',
        hint: 'AWS S3 를 그대로 쓸 때는 비워둡니다.',
      },
      { key: 'bucket', label: '버킷', kind: 'text', required: true, placeholder: 'stonex' },
      { key: 'region', label: '리전', kind: 'text', placeholder: 'us-east-1' },
      { key: 'accessKey', label: '액세스 키', kind: 'secret' },
      { key: 'secretKey', label: '시크릿 키', kind: 'secret' },
    ],
  },
];

export function findCategory(category: string): SettingCategory | undefined {
  return SETTING_CATEGORIES.find((c) => c.category === category);
}

export function findField(category: string, key: string): SettingField | undefined {
  return findCategory(category)?.fields.find((f) => f.key === key);
}
