/**
 * 메일 어댑터 단위 테스트.
 *
 * 실제 발송은 하지 않는다 — 외부 의존을 테스트에 끌어들이면 CI 가 남의 서비스 상태에
 * 좌우된다. 여기서 고정하는 것은 **경계의 계약**이다: 설정이 없으면 조용히 성공하지 않고,
 * 토큰이 든 본문은 로그에 남지 않는다.
 */
import { ConfiguredMailer } from '../src/auth/mailer';
import type { SettingsService } from '../src/settings/settings.service';

/** 설정을 통제하는 스텁 — DB 없이 경계만 본다 */
const stubSettings = (values: Record<string, string>, generation = 1): SettingsService =>
  ({
    values: async () => values,
    get generation() {
      return generation;
    },
  }) as unknown as SettingsService;

describe('ConfiguredMailer', () => {
  const original = process.env.DEV_MAIL_LOG_BODY;
  afterEach(() => {
    if (original === undefined) delete process.env.DEV_MAIL_LOG_BODY;
    else process.env.DEV_MAIL_LOG_BODY = original;
  });

  it('transport=console 이면 발송하지 않고, 본문(토큰)도 로그에 남기지 않는다', async () => {
    delete process.env.DEV_MAIL_LOG_BODY;
    const mailer = new ConfiguredMailer(stubSettings({ transport: 'console' }));
    const logged: string[] = [];
    jest.spyOn(mailer['logger'], 'log').mockImplementation((m) => { logged.push(String(m)); });

    await mailer.send('a@t.local', '비밀번호 재설정', '재설정 토큰: SECRET-TOKEN');

    // 로그는 수집기로 흘러가고 보존이 길다 — 한 번 들어간 토큰은 회수하기 어렵다
    expect(logged.join('\n')).not.toContain('SECRET-TOKEN');
    expect(logged.join('\n')).toContain('a@t.local');
  });

  it('DEV_MAIL_LOG_BODY=1 일 때만 본문을 남긴다 (로컬에서 토큰을 확인하기 위한 개발 장치)', async () => {
    process.env.DEV_MAIL_LOG_BODY = '1';
    const mailer = new ConfiguredMailer(stubSettings({ transport: 'console' }));
    const logged: string[] = [];
    jest.spyOn(mailer['logger'], 'log').mockImplementation((m) => { logged.push(String(m)); });

    await mailer.send('a@t.local', '이메일 변경 확인', '확인 토큰: SECRET-TOKEN');

    expect(logged.join('\n')).toContain('SECRET-TOKEN');
  });

  it('SMTP 인데 설정이 비어 있으면 조용히 성공하지 않고 실패한다', async () => {
    const mailer = new ConfiguredMailer(stubSettings({ transport: 'smtp' }));
    // "보낸 줄 알았는데 안 간" 상태가 가장 나쁘다
    await expect(mailer.send('a@t.local', '제목', '본문')).rejects.toThrow(/메일 설정/);
  });

  it('설정이 바뀌면 전송기를 다시 만든다 (재기동 없이 반영)', async () => {
    const first = stubSettings(
      { transport: 'smtp', host: 'smtp.a.local', port: '465', user: 'u', password: 'p' }, 1,
    );
    const mailer = new ConfiguredMailer(first);
    const config = await first.values('mail');
    // 전송기가 만들어진다
    expect(() => mailer['transportFor'](config)).not.toThrow();
    const built = mailer['transport'];

    // 세대가 오르면(설정 변경) 같은 요청이어도 새로 만든다
    Object.defineProperty(first, 'generation', { get: () => 2 });
    mailer['transportFor']({ transport: 'smtp', host: 'smtp.b.local', port: '587', user: 'u', password: 'p' });
    expect(mailer['transport']).not.toBe(built);
  });
});
