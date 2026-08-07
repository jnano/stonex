import type { ReactNode } from 'react';
import { SessionProvider } from '../lib/session';

export const metadata = {
  title: 'stonex 관리자',
  description: '권한 관리 웹 애플리케이션',
};

/** 루트 레이아웃 — 세션(권한 스냅샷)을 하위 화면에 제공한다(§8.4) */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f6f7f9' }}>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
