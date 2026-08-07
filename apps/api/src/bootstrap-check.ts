import 'reflect-metadata';
import { CONTROLLERS } from './app.controllers';
import { findUndeclaredEndpoints } from './authorization/startup-check';

/**
 * G-5 미선언 엔드포인트 검사 (기획서 §14.2 — §7.3 기동 차단의 CI 선행 실행).
 * 실행: pnpm g5  (DB·서버 기동 불필요 — 순수 리플렉션)
 */
const violations = findUndeclaredEndpoints(CONTROLLERS);
if (violations.length > 0) {
  console.error(`G-5 실패 — 권한 미선언 엔드포인트 ${violations.length}건 (@RequirePermission 또는 @Public 필수):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`G-5 통과: 전 라우트 권한 선언 확인 (컨트롤러 ${CONTROLLERS.length}개)`);
