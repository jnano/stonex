import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { AUTH_ONLY_META, PERMISSION_META, PUBLIC_META } from './decorators';

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
        Reflect.getMetadata(PUBLIC_META, handler) === true ||
        Reflect.getMetadata(AUTH_ONLY_META, handler) === true;
      if (!declared) {
        violations.push(`${controller.name}.${name}`);
      }
    }
  }
  return violations;
}

/**
 * 선언된 전 라우트 목록을 `"METHOD /path"` 형태로 반환한다.
 * G-1 매트릭스 등록 누락 검사가 이 목록을 정본으로 삼는다 —
 * G-5 는 "권한 선언 누락"을 잡지만 "매트릭스 등록 누락"은 잡지 못하므로 별도 장치가 필요하다(R-7).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function listRoutes(controllers: Array<new (...args: any[]) => unknown>): string[] {
  const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];
  const routes: string[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '').replace(/^\/|\/$/g, '');
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (typeof handler !== 'function') continue;
      const sub = Reflect.getMetadata(PATH_METADATA, handler);
      const verb = Reflect.getMetadata(METHOD_METADATA, handler);
      if (sub === undefined || verb === undefined) continue;
      const suffix = String(sub).replace(/^\/|\/$/g, '');
      const full = ['', base, suffix].filter((seg, i) => i === 0 || seg.length > 0).join('/') || '/';
      routes.push(`${METHOD_NAMES[Number(verb)] ?? 'GET'} ${full}`);
    }
  }
  return routes.sort();
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
