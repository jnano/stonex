import type { ReactNode } from 'react';

export const metadata = {
  title: 'stonex',
  description: '권한 관리 웹 애플리케이션',
};

/** 루트 레이아웃. 관리자 콘솔 화면은 WP-7에서 구현된다. */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
