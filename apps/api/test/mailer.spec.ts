/**
 * 메일 어댑터 단위 테스트 (§13.2 결정: 개발 단계 Gmail SMTP).
 *
 * 실제 발송은 하지 않는다 — 외부 의존을 테스트에 끌어들이면 CI 가 남의 서비스 상태에
 * 좌우된다. 여기서 고정하는 것은 **경계의 계약**이다: 설정이 없으면 조용히 성공하지 않고,
 * 토큰이 든 본문은 로그에 남지 않는다.
 */
import { ConsoleMailer, SmtpMailer } from '../src/auth/mailer';

describe('ConsoleMailer (개발용)', () => {
  const original = process.env.DEV_MAIL_LOG_BODY;
  afterEach(() => {
    if (original === undefined) delete process.env.DEV_MAIL_LOG_BODY;
    else process.env.DEV_MAIL_LOG_BODY = original;
  });

  it('기본값에서는 본문(토큰)을 로그에 남기지 않는다', async () => {
    delete process.env.DEV_MAIL_LOG_BODY;
    const mailer = new ConsoleMailer();
    const logged: string[] = [];
    jest.spyOn(mailer['logger'], 'log').mockImplementation((m) => { logged.push(String(m)); });

    await mailer.send('a@t.local', '비밀번호 재설정', '재설정 토큰: SECRET-TOKEN');

    // 로그는 수집기로 흘러가고 보존이 길다 — 한 번 들어간 토큰은 회수하기 어렵다
    expect(logged.join('\n')).not.toContain('SECRET-TOKEN');
    expect(logged.join('\n')).toContain('a@t.local');
  });

  it('DEV_MAIL_LOG_BODY=1 일 때만 본문을 남기고, 그 사실을 경고한다', async () => {
    process.env.DEV_MAIL_LOG_BODY = '1';
    const mailer = new ConsoleMailer();
    const logged: string[] = [];
    const warned: string[] = [];
    jest.spyOn(mailer['logger'], 'log').mockImplementation((m) => { logged.push(String(m)); });
    jest.spyOn(mailer['logger'], 'warn').mockImplementation((m) => { warned.push(String(m)); });

    await mailer.send('a@t.local', '이메일 변경 확인', '확인 토큰: SECRET-TOKEN');

    expect(logged.join('\n')).toContain('SECRET-TOKEN');
    // 켜져 있다는 사실이 로그에 드러나야 운영에서 켠 채로 두는 것을 알아챈다
    expect(warned.join('\n')).toContain('운영에서는 반드시 끄십시오');
  });
});

describe('SmtpMailer', () => {
  const keys = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('설정이 없으면 기동은 막지 않되 발송 시점에 명확히 실패한다', async () => {
    for (const k of keys) delete process.env[k];
    const mailer = new SmtpMailer();
    jest.spyOn(mailer['logger'], 'error').mockImplementation(() => undefined);

    // 기동을 막으면 메일이 필요 없는 경로까지 함께 죽는다 — 설정 하나가 서비스 전체를 세운다
    expect(() => mailer.onModuleInit()).not.toThrow();
    // 그러나 조용히 성공해서는 안 된다. "보낸 줄 알았는데 안 간" 상태가 가장 나쁘다
    await expect(mailer.send('a@t.local', '제목', '본문')).rejects.toThrow(/SMTP 설정/);
  });

  it('설정이 있으면 전송기를 구성한다', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_USER = 'sender@gmail.com';
    process.env.SMTP_PASSWORD = 'app-password';
    const mailer = new SmtpMailer();

    mailer.onModuleInit();
    expect(mailer['transport']).not.toBeNull();
  });
});
