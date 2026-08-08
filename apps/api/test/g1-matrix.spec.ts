/**
 * G-1 권한 매트릭스 골든 파일 검증 (기획서 §14.2, RT-5).
 *
 * "비인증 + 역할 5종(6행) × Phase 1 전체 API → 허용/거부" 표를 **실제 API 요청으로 재생성**해
 * governance/matrix.yaml 과 비교한다. 1칸이라도 다르면 실패한다.
 * 의도한 변경이면 골든 파일을 갱신하는 커밋 + 리뷰 승인이 필요하다 —
 * 이로써 권한 변화가 코드 리뷰의 1급 검토 대상이 된다.
 *
 * 갱신: UPDATE_MATRIX=1 pnpm --filter @stonex/api exec jest test/g1-matrix.spec.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@stonex/db';
import { TokenService } from '../src/auth/token.service';
import { createPrisma, createTestApp, uid } from './support/test-app';
import { MATRIX_ROWS, RowActor, createActorForRole, seedRolesForTenant } from './support/matrix-fixture';
// 주: `app.controllers`(→ auth.controller)는 **정적으로 import 하지 않는다.**
// 그 모듈이 로드되는 순간 @Throttle 데코레이터가 평가되어 AUTH_RATE_LIMIT 이 고정되므로,
// 아래 beforeAll 의 환경 변수 설정이 무효가 된다. 필요한 곳에서 동적으로 가져온다.

jest.setTimeout(180_000);

const GOLDEN_PATH = path.resolve(__dirname, '../../../governance/matrix.yaml');
const TENANT = '00000000-0000-0000-0000-000000009993';

/**
 * 매트릭스에 포함할 API 목록.
 * 새 엔드포인트를 추가하면 여기에도 반드시 등록한다 — 누락은 매트릭스의 사각지대가 된다.
 * (G-5 가 "선언 누락"을 잡는다면, 이 목록은 "검증 누락"을 막는 장치다)
 */
const ENDPOINTS: Array<{
  id: string;
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  path: string;
  body?: object;
  /**
   * 5xx 가 그 엔드포인트의 **설계된 정상 응답**인 경우에만 지정한다(현재 readiness 하나뿐).
   * 기본값은 "5xx = 판정 불가 → 테스트 실패"이며, 그 엄격함을 여기서 함부로 풀지 않는다.
   */
  serverErrorIsValid?: true;
}> = [
  { id: 'GET /health', method: 'get', path: '/api/v1/health' },
  { id: 'GET /health/live', method: 'get', path: '/api/v1/health/live' },
  // readiness 는 의존성이 내려가면 503 을 반환하도록 설계돼 있다(WP-9). CI 환경에 스토리지가
  // 없으면 503 이 정상이며, 이는 권한 판정과 무관하다 — @Public 이므로 인가는 통과한 것이다.
  { id: 'GET /health/ready', method: 'get', path: '/api/v1/health/ready', serverErrorIsValid: true },
  { id: 'GET /me', method: 'get', path: '/api/v1/me' },
  { id: 'GET /members', method: 'get', path: '/api/v1/members' },
  { id: 'GET /members/me', method: 'get', path: '/api/v1/members/me' },
  { id: 'PATCH /members/me', method: 'patch', path: '/api/v1/members/me', body: { name: 'x' } },
  { id: 'GET /members/:id', method: 'get', path: '/api/v1/members/{target}' },
  { id: 'GET /members/:id/manageable', method: 'get', path: '/api/v1/members/{target}/manageable' },
  { id: 'PATCH /members/:id', method: 'patch', path: '/api/v1/members/{target}', body: { name: 'x' } },
  { id: 'POST /members/:id/ban', method: 'post', path: '/api/v1/members/{target}/ban' },
  { id: 'POST /members/:id/roles', method: 'post', path: '/api/v1/members/{target}/roles', body: { roleId: '{memberRole}' } },
  { id: 'DELETE /members/:id', method: 'delete', path: '/api/v1/members/{target}' },
  // WP-10 파일 (회원 경로 + /admin 분리 경로)
  //
  // 삭제는 성공하면 대상을 소멸시킨다. 공용 픽스처를 쓰면 **먼저 지운 행이 뒤 행을 404 로 만들어**
  // 그 뒤 행들이 전부 deny 로 기록된다 — 권한이 아니라 실행 순서가 만든 값이다.
  // 그래서 삭제 라우트만 행마다 별도 리소스({rowFile}·{rowDomain})를 대상으로 삼는다.
  { id: 'POST /files/upload-url', method: 'post', path: '/api/v1/files/upload-url', body: { name: 'a.txt', mimeType: 'text/plain', sizeBytes: 10 } },
  { id: 'GET /files', method: 'get', path: '/api/v1/files' },
  { id: 'GET /files/:id', method: 'get', path: '/api/v1/files/{file}' },
  { id: 'GET /files/:id/download-url', method: 'get', path: '/api/v1/files/{file}/download-url' },
  { id: 'PATCH /files/:id', method: 'patch', path: '/api/v1/files/{file}', body: { name: 'b.txt' } },
  { id: 'DELETE /files/:id', method: 'delete', path: '/api/v1/files/{rowFile}' },
  { id: 'POST /files/:id/shares', method: 'post', path: '/api/v1/files/{file}/shares', body: { subjectId: '{target}', permissions: ['file.read'] } },
  { id: 'GET /files/:id/shares', method: 'get', path: '/api/v1/files/{file}/shares' },
  { id: 'DELETE /files/:id/shares/:grantId', method: 'delete', path: '/api/v1/files/{rowFile}/shares/{rowFileGrant}' },
  { id: 'POST /admin/files/:id/shares', method: 'post', path: '/api/v1/admin/files/{file}/shares', body: { subjectId: '{target}', permissions: ['file.read'] } },
  { id: 'GET /admin/files', method: 'get', path: '/api/v1/admin/files' },
  { id: 'GET /admin/files/:id', method: 'get', path: '/api/v1/admin/files/{file}' },
  // WP-13 에서 뚫은 관리자 공유 회수 경로 (정책 함수의 ADMIN 분기에 도달하는 유일한 라우트).
  // **파일 삭제보다 앞**에 둔다 — 삭제된 파일에서는 404 가 되어 인가 판정이 가려진다.
  { id: 'DELETE /admin/files/:id/shares/:grantId', method: 'delete', path: '/api/v1/admin/files/{rowFile}/shares/{rowFileGrant}' },
  { id: 'DELETE /admin/files/:id', method: 'delete', path: '/api/v1/admin/files/{rowFile}' },
  // WP-12 도메인 (회원 경로 + /admin 분리 경로)
  { id: 'POST /domains', method: 'post', path: '/api/v1/domains', body: { fqdn: 'matrix-new.example.com' } },
  { id: 'GET /domains', method: 'get', path: '/api/v1/domains' },
  { id: 'GET /domains/:id', method: 'get', path: '/api/v1/domains/{domain}' },
  { id: 'GET /domains/:id/verification', method: 'get', path: '/api/v1/domains/{domain}/verification' },
  { id: 'POST /domains/:id/verify', method: 'post', path: '/api/v1/domains/{domain}/verify' },
  { id: 'PATCH /domains/:id', method: 'patch', path: '/api/v1/domains/{domain}', body: { fqdn: 'matrix-edit.example.com' } },
  { id: 'GET /admin/domains', method: 'get', path: '/api/v1/admin/domains' },
  { id: 'GET /admin/domains/:id', method: 'get', path: '/api/v1/admin/domains/{domain}' },
  { id: 'PATCH /admin/domains/:id', method: 'patch', path: '/api/v1/admin/domains/{domain}', body: { fqdn: 'matrix-admin.example.com' } },
  { id: 'POST /admin/domains/:id/verify', method: 'post', path: '/api/v1/admin/domains/{domain}/verify' },
  // WP-13 위임·이전
  { id: 'POST /domains/:id/delegations', method: 'post', path: '/api/v1/domains/{domain}/delegations', body: { subjectId: '{target}', permissions: ['domain.read'] } },
  { id: 'GET /domains/:id/delegations', method: 'get', path: '/api/v1/domains/{domain}/delegations' },
  { id: 'DELETE /domains/:id/delegations/:grantId', method: 'delete', path: '/api/v1/domains/{rowDomain}/delegations/{rowDomainGrant}' },
  { id: 'POST /domains/:id/transfers', method: 'post', path: '/api/v1/domains/{domain}/transfers', body: { toUserId: '{target}' } },
  { id: 'DELETE /domains/:id/transfers/:transferId', method: 'delete', path: '/api/v1/domains/{domain}/transfers/00000000-0000-0000-0000-000000000000' },
  { id: 'GET /admin/domains/:id/delegations', method: 'get', path: '/api/v1/admin/domains/{domain}/delegations' },
  { id: 'DELETE /admin/domains/:id/delegations/:grantId', method: 'delete', path: '/api/v1/admin/domains/{rowDomain}/delegations/{rowDomainGrant}' },
  { id: 'GET /transfers', method: 'get', path: '/api/v1/transfers' },
  { id: 'POST /transfers/:id/accept', method: 'post', path: '/api/v1/transfers/00000000-0000-0000-0000-000000000000/accept' },
  { id: 'DELETE /domains/:id', method: 'delete', path: '/api/v1/domains/{rowDomain}' },
  { id: 'DELETE /admin/domains/:id', method: 'delete', path: '/api/v1/admin/domains/{rowDomain}' },
  // 인증 API (전부 @Public — 비인증 행이 allow 여야 정상이며, 하나라도 deny 로 바뀌면 회귀다)
  { id: 'POST /auth/signup', method: 'post', path: '/api/v1/auth/signup', body: { email: 'm@t.local', password: 'x', name: 'n' } },
  { id: 'POST /auth/login', method: 'post', path: '/api/v1/auth/login', body: { email: 'm@t.local', password: 'x' } },
  { id: 'POST /auth/refresh', method: 'post', path: '/api/v1/auth/refresh', body: { refreshToken: 'x' } },
  { id: 'POST /auth/verify-email', method: 'post', path: '/api/v1/auth/verify-email', body: { token: 'x' } },
  { id: 'POST /auth/password-reset/request', method: 'post', path: '/api/v1/auth/password-reset/request', body: { email: 'm@t.local' } },
  { id: 'POST /auth/password-reset/confirm', method: 'post', path: '/api/v1/auth/password-reset/confirm', body: { token: 'x', password: 'y' } },
  // 온보딩 (@AuthenticatedOnly — 인증만 요구, 권한 검사 대상 아님)
  { id: 'GET /auth/onboarding/status', method: 'get', path: '/api/v1/auth/onboarding/status' },
  { id: 'POST /auth/onboarding/password', method: 'post', path: '/api/v1/auth/onboarding/password', body: { password: 'new-password-1234' } },
  { id: 'POST /auth/onboarding/totp', method: 'post', path: '/api/v1/auth/onboarding/totp' },
  { id: 'POST /auth/onboarding/totp/confirm', method: 'post', path: '/api/v1/auth/onboarding/totp/confirm', body: { code: '000000' } },
  // 회원 관리 잔여
  { id: 'DELETE /members/:id/roles/:roleId', method: 'delete', path: '/api/v1/members/{target}/roles/{memberRole}' },
  { id: 'POST /members/:id/unban', method: 'post', path: '/api/v1/members/{target}/unban' },
  // 역할 관리 잔여
  { id: 'GET /admin/roles/:id', method: 'get', path: '/api/v1/admin/roles/{memberRole}' },
  { id: 'PATCH /admin/roles/:id', method: 'patch', path: '/api/v1/admin/roles/{memberRole}', body: { name: 'x' } },
  { id: 'POST /admin/roles/:id/duplicate', method: 'post', path: '/api/v1/admin/roles/{memberRole}/duplicate', body: { code: 'DUP', name: 'dup' } },
  { id: 'POST /files/complete', method: 'post', path: '/api/v1/files/complete', body: { uploadId: '00000000-0000-0000-0000-000000000000', checksum: 'c' } },
  { id: 'GET /admin/roles', method: 'get', path: '/api/v1/admin/roles' },
  { id: 'GET /admin/roles/permissions', method: 'get', path: '/api/v1/admin/roles/permissions' },
  { id: 'POST /admin/roles', method: 'post', path: '/api/v1/admin/roles', body: { code: 'X', name: 'X' } },
  { id: 'PUT /admin/roles/:id/permissions', method: 'put', path: '/api/v1/admin/roles/{memberRole}/permissions', body: { codes: [] } },
  { id: 'DELETE /admin/roles/:id', method: 'delete', path: '/api/v1/admin/roles/{memberRole}' },
];

/** 응답 상태 → 매트릭스 값. 권한 관점에서 '허용'인지 '거부'인지만 남긴다 */
function verdict(status: number, context: string, serverErrorIsValid = false): 'allow' | 'deny' {
  // 401/403/404 는 거부. 404 는 존재 은닉(§10.2)도 포함하므로 거부로 본다.
  // 4xx 중 400/409 는 권한은 통과하고 입력·상태 때문에 실패한 것이므로 '허용'으로 분류한다.
  if (status === 401 || status === 403 || status === 404) return 'deny';
  // **429·5xx 는 판정이 아니다.** 이전 구현은 이것들을 'allow' 로 접어 넣었고, 그 결과
  // 속도 제한에 걸린 행이 골든 파일에 "권한 허용"으로 굳어 있었다(WP-12에서 발견 —
  // 인증용 throttler 가 전 라우트에 적용돼 매트릭스의 마지막 행이 항상 429 였다).
  // 판정 불가는 조용히 통과시키지 말고 실패시킨다.
  if (status === 429 || (status >= 500 && !serverErrorIsValid)) {
    throw new Error(`매트릭스 판정 불가(${status}): ${context} — 권한이 아니라 속도 제한·서버 오류다.`);
  }
  return 'allow';
}

type Matrix = Record<string, Record<string, string>>;

describe('G-1 권한 매트릭스', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let actors: RowActor[];
  let targetUserId: string;
  let memberRoleId: string;
  let fileId: string;
  let domainId: string;
  /** 삭제 라우트 전용 — 행마다 별도 리소스를 준다(공용 픽스처를 쓰면 실행 순서가 판정을 오염시킨다) */
  const rowFiles: Record<string, string> = {};
  const rowDomains: Record<string, string> = {};
  // 회수 라우트가 **존재하는** Grant 를 가리켜야 게이트 판정이 드러난다.
  // 없는 id 를 쓰면 인가를 통과한 행도 서비스에서 404 가 되어 전부 deny 로 기록된다.
  const rowFileGrants: Record<string, string> = {};
  const rowDomainGrants: Record<string, string> = {};

  beforeAll(async () => {
    prisma = createPrisma();
    const roleIds = await seedRolesForTenant(prisma, TENANT);
    const permIds = Object.fromEntries(
      (await prisma.permission.findMany({ select: { code: true, id: true } })).map((p) => [p.code, p.id]),
    );
    memberRoleId = roleIds['MEMBER'];

    const tokens = new TokenService();
    actors = [{ row: 'anonymous', userId: null, authorization: null }];
    for (const row of MATRIX_ROWS.filter((r) => r !== 'anonymous')) {
      actors.push(await createActorForRole(prisma, tokens, TENANT, row, roleIds));
    }

    // 관리 행위의 대상 — 어떤 행위자보다 권한이 약해야 우위 검사가 권한 자체를 가리지 않는다
    const target = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `target-${uid()}@t.local`, password_hash: 'x',
        name: '대상', status: 'ACTIVE',
      },
    });
    targetUserId = target.id;

    // 리소스 픽스처의 소유자는 **관리 대상(target)과 분리한다.**
    // 같은 사용자로 두면 앞서 실행되는 `DELETE /members/:id` 가 그 회원을 삭제하면서
    // 소유 파일까지 동반 삭제하고(MEM-6·WT-17), 이후 모든 리소스형 라우트가 404 가 되어
    // **`.all` 관리자 경로의 판정이 통째로 사각지대가 된다** — WP-12에서 발견됐다.
    // Grant 의 subject 도 관리 대상(target)과 분리한다. target 을 지우면 그 사용자를 subject 로 하는
    // Grant 가 전부 정리되어(§5.3 cleanupForSubject), 회수 라우트가 죄다 404 가 된다.
    const grantSubject = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `grantee-${uid()}@t.local`, password_hash: 'x',
        name: 'Grant 대상', status: 'ACTIVE',
      },
    });

    const resourceOwner = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `resowner-${uid()}@t.local`, password_hash: 'x',
        name: '리소스 소유자', status: 'ACTIVE',
      },
    });

    // 소유자는 어떤 행위자도 아니므로, 각 역할 행은 "타인 소유 리소스"에 대한 판정이 된다
    // — 관계 축 확장(RT-17) 전까지의 기본 컨텍스트다.
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: resourceOwner.id, name: 'matrix.txt',
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });
    fileId = file.id;

    // 도메인도 소유자를 target 으로 둔다 — 각 역할 행은 "타인 소유 도메인"에 대한 판정이 된다
    const domain = await prisma.domain.create({
      data: {
        tenant_id: TENANT, owner_id: resourceOwner.id,
        fqdn: `matrix-${uid()}.example.com`, status: 'UNVERIFIED',
      },
    });
    domainId = domain.id;
    for (const row of MATRIX_ROWS) {
      const perRowFile = await prisma.file.create({
        data: {
          tenant_id: TENANT, owner_id: resourceOwner.id, name: `matrix-del-${row}.txt`,
          storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
        },
      });
      rowFiles[row] = perRowFile.id;
      rowFileGrants[row] = (await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: grantSubject.id, resource_type: 'file',
          resource_id: perRowFile.id, permission_id: permIds['file.read'],
          effect: 'ALLOW', granted_by: resourceOwner.id,
        },
      })).id;
      const perRow = await prisma.domain.create({
        data: {
          tenant_id: TENANT, owner_id: resourceOwner.id,
          fqdn: `matrix-del-${row.toLowerCase()}-${uid()}.example.com`, status: 'UNVERIFIED',
        },
      });
      rowDomains[row] = perRow.id;
      rowDomainGrants[row] = (await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: grantSubject.id, resource_type: 'domain',
          resource_id: perRow.id, permission_id: permIds['domain.read'],
          effect: 'ALLOW', granted_by: resourceOwner.id,
        },
      })).id;
    }

    // 인증 API 는 §10.4 로 5회/분이라 6행을 연속 호출하면 마지막 행이 429 가 된다.
    // 매트릭스가 재는 것은 권한 판정이지 속도 제한이 아니므로, 여기서만 상향한다.
    // (createTestApp 이 AppModule 을 동적 import 하므로 이 설정이 데코레이터에 반영된다)
    process.env.AUTH_RATE_LIMIT = '1000';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.fileUpload.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domainVerificationAttempt.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domain.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
  });

  it('실제 API 로 재생성한 매트릭스가 골든 파일과 일치한다', async () => {
    const generated: Matrix = {};

    for (const endpoint of ENDPOINTS) {
      generated[endpoint.id] = {};
      for (const actor of actors) {
        const url = endpoint.path
          .replace('{target}', targetUserId)
          .replace('{memberRole}', memberRoleId)
          .replace('{rowFileGrant}', rowFileGrants[actor.row])
          .replace('{rowDomainGrant}', rowDomainGrants[actor.row])
          .replace('{rowFile}', rowFiles[actor.row])
          .replace('{file}', fileId)
          .replace('{rowDomain}', rowDomains[actor.row])
          .replace('{domain}', domainId);
        const body = JSON.parse(
          JSON.stringify(endpoint.body ?? {})
            .replace('{memberRole}', memberRoleId)
            .replace('{target}', targetUserId),
        );

        let req = request(app.getHttpServer())[endpoint.method](url);
        if (actor.authorization) req = req.set('Authorization', actor.authorization);
        if (endpoint.body) req = req.send(body);
        const res = await req;
        generated[endpoint.id][actor.row] = verdict(
          res.status, `${endpoint.id} / ${actor.row}`, endpoint.serverErrorIsValid,
        );
      }
    }

    if (process.env.UPDATE_MATRIX === '1') {
      writeGolden(generated);
      console.log('골든 파일을 갱신했습니다. 변경 내용을 리뷰에서 확인하세요.');
      return;
    }
    const golden = readGolden();

    // 표 전체를 한 번에 비교해 diff 가 리뷰 화면에 그대로 드러나게 한다
    expect(generated).toEqual(golden);
  });

  it('선언된 모든 라우트가 매트릭스에 등록되어 있다 (R-7 — 검증 사각지대 방지)', async () => {
    // G-5 는 "권한 선언 누락"을 잡지만 "매트릭스 등록 누락"은 잡지 못한다.
    // 등록하지 않은 라우트는 어떤 회귀도 검출되지 않는 사각지대가 되므로 여기서 기계적으로 막는다.
    const { CONTROLLERS } = await import('../src/app.controllers');
    const { listRoutes } = await import('../src/authorization/startup-check');
    const declared = listRoutes(CONTROLLERS);
    const registered = new Set(ENDPOINTS.map((e) => e.id));
    const missing = declared.filter((r) => !registered.has(r));
    expect(missing).toEqual([]);
  });

  it('@Public 선언 목록과 비인증 행이 1:1 로 대응한다 (RT-5)', async () => {
    const golden = readGolden();
    const anonymousAllowed = Object.entries(golden)
      .filter(([, row]) => row.anonymous === 'allow')
      .map(([id]) => id);
    // 공개 API 는 헬스체크 계열뿐이다. **이 목록이 늘어나는 것은 공개 표면이 넓어졌다는 뜻이므로,
    // 보호 API 가 실수로 @Public 이 되면 여기서 반드시 실패한다.** 목록 수정은 의도적 승인 행위다.
    // (WP-9에서 liveness/readiness 를 분리하며 2건이 추가됐다 — 의존성 상태를 로드밸런서에 알리는
    //  용도이며 인증을 요구하면 목적을 잃는다.)
    expect(anonymousAllowed).toEqual([
      // 헬스체크 — 의존성 상태를 로드밸런서에 알리는 용도라 인증을 요구하면 목적을 잃는다
      'GET /health', 'GET /health/live', 'GET /health/ready',
      // 인증 진입점 — 로그인 전에 호출해야 하므로 본질적으로 공개다(§6.1 AUTH-1·AUTH-4)
      'POST /auth/signup', 'POST /auth/verify-email',
      'POST /auth/password-reset/request', 'POST /auth/password-reset/confirm',
    ]);
    // 주: POST /auth/login·/auth/refresh 도 @Public 이지만 자격 증명이 없으면 401 을 반환하므로
    // 매트릭스에는 deny 로 기록된다. 즉 이 목록은 "인증 없이 성공하는 API"의 목록이다.
  });
});

function readGolden(): Matrix {
  const raw = fs.readFileSync(GOLDEN_PATH, 'utf8');
  const start = raw.indexOf('matrix:');
  if (start < 0) throw new Error('골든 파일에 matrix 섹션이 없습니다. UPDATE_MATRIX=1 로 생성하세요.');
  const matrix: Matrix = {};
  let current: string | null = null;
  for (const line of raw.slice(start).split('\n').slice(1)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const endpointMatch = /^ {2}"([^"]+)":\s*$/.exec(line);
    if (endpointMatch) {
      current = endpointMatch[1];
      matrix[current] = {};
      continue;
    }
    const cellMatch = /^ {4}(\w+):\s*(allow|deny)\s*$/.exec(line);
    if (cellMatch && current) matrix[current][cellMatch[1]] = cellMatch[2];
  }
  return matrix;
}

function writeGolden(matrix: Matrix): void {
  const header = [
    '# G-1 권한 매트릭스 골든 파일 (기획서 §14.2, RT-5)',
    '#',
    '# "비인증(anonymous) + 역할 5종 × Phase 1 전체 API → 허용/거부" 표.',
    '# test/g1-matrix.spec.ts 가 실제 API 요청으로 이 표를 재생성해 비교한다. 1칸이라도 다르면 CI 실패.',
    '# 의도한 변경이면 UPDATE_MATRIX=1 로 갱신하고, 그 diff 를 리뷰에서 승인받아야 한다.',
    '# perm: 커밋은 이 파일의 변경을 동반해야 한다(§16.3-3).',
    '',
    'matrix:',
  ].join('\n');
  const body = Object.entries(matrix)
    .map(([id, row]) => `  "${id}":\n${Object.entries(row).map(([k, v]) => `    ${k}: ${v}`).join('\n')}`)
    .join('\n');
  fs.writeFileSync(GOLDEN_PATH, `${header}\n${body}\n`);
}
