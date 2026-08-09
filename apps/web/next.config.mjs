import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Next 설정.
 *
 * **저장소 루트의 `.env` 를 읽는다.** Next 는 기본적으로 앱 디렉터리(apps/web)의
 * `.env` 만 보는데, 이 저장소는 설정을 루트 한 곳에 모으는 규약이다(API 도 main.ts 에서
 * 루트 `.env` 를 명시 경로로 읽는다). 규약이 앱마다 다르면 "API 는 되는데 화면은
 * 안 되는" 상태가 생긴다 — 개발 로그인 버튼이 안 보였던 것이 그 사례다.
 *
 * dotenv 로 process.env 에 올리는 것만으로는 부족하다: Next 는 **자체 env 로더가 수집한
 * 목록**을 기준으로 클라이언트 번들에 인라인하므로, 나중에 process.env 에 넣은 값은
 * 번들에 들어가지 않는다. 그래서 `env` 키로 **명시 주입**한다.
 *
 * 값이 없으면 키 자체를 넘기지 않는다 — 그러면 `process.env.NEXT_PUBLIC_DEV_LOGIN` 은
 * undefined 로 컴파일되고 개발 전용 코드는 번들에서 사라진다(배포 차단이 이 성질에
 * 기대고 있다 — apps/api/src/auth/dev-login.ts 참조).
 */
const rootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
config({ path: rootEnv });

/** 루트 .env 에서 가져와 클라이언트 번들로 넘길 공개 변수 */
const publicEnv = Object.fromEntries(
  ['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_DEV_LOGIN']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: publicEnv,
};

export default nextConfig;
