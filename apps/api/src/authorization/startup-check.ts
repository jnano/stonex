import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSION_META, PUBLIC_META } from './decorators';

/**
 * 미선언 엔드포인트 기동 차단 (기획서 §7.3, INV-5).
 * 모든 컨트롤러의 라우트 핸들러가 @RequirePermission 또는 @Public 을 선언했는지 검사한다.
 * - 서버 기동 시: main.ts 가 listen 전에 호출 — 위반 시 기동 실패
 * - CI(G-5): bootstrap-check.ts 가 동일 함수를 실행 — 위반 시 빌드 실패
 * 순수 리플렉션 검사라 DB·DI 없이 동작한다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS 컨트롤러 클래스 목록
export function findUndeclaredEndpoints(controllers: Array<new (...args: any[]) => unknown>): string[] {
  const violations: string[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;
      // 라우트 핸들러 판별: @Get/@Post 등이 남기는 경로·메서드 메타데이터
      const isRoute =
        Reflect.getMetadata(PATH_METADATA, handler) !== undefined &&
        Reflect.getMetadata(METHOD_METADATA, handler) !== undefined;
      if (!isRoute) continue;
      const declared =
        Reflect.getMetadata(PERMISSION_META, handler) !== undefined ||
        Reflect.getMetadata(PUBLIC_META, handler) === true;
      if (!declared) {
        violations.push(`${controller.name}.${name}`);
      }
    }
  }
  return violations;
}

/** 위반이 있으면 즉시 예외 — 서버 기동을 실패시킨다 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enforceEndpointDeclarations(controllers: Array<new (...args: any[]) => unknown>): void {
  const violations = findUndeclaredEndpoints(controllers);
  if (violations.length > 0) {
    throw new Error(
      `권한 미선언 엔드포인트 발견 (기획서 §7.3 — @RequirePermission 또는 @Public 필수):\n` +
        violations.map((v) => `  - ${v}`).join('\n'),
    );
  }
}
