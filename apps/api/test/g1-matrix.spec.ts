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
import { CONTROLLERS } from '../src/app.controllers';
import { listRoutes } from '../src/authorization/startup-check';

jest.setTimeout(180_000);

const GOLDEN_PATH = path.resolve(__dirname, '../../../governance/matrix.yaml');
const TENANT = '00000000-0000-0000-0000-000000009993';

/**
 * 매트릭스에 포함할 API 목록.
 * 새 엔드포인트를 추가하면 여기에도 반드시 등록한다 — 누락은 매트릭스의 사각지대가 된다.
 * (G-5 가 "선언 누락"을 잡는다면, 이 목록은 "검증 누락"을 막는 장치다)
 */
const ENDPOINTS: Array<{ id: string; method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string; body?: object }> = [
  { id: 'GET /health', method: 'get', path: '/api/v1/health' },
  { id: 'GET /health/live', method: 'get', path: '/api/v1/health/live' },
  { id: 'GET /health/ready', method: 'get', path: '/api/v1/health/ready' },
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
  { id: 'POST /files/upload-url', method: 'post', path: '/api/v1/files/upload-url', body: { name: 'a.txt', mimeType: 'text/plain', sizeBytes: 10 } },
  { id: 'GET /files', method: 'get', path: '/api/v1/files' },
  { id: 'GET /files/:id', method: 'get', path: '/api/v1/files/{file}' },
  { id: 'GET /files/:id/download-url', method: 'get', path: '/api/v1/files/{file}/download-url' },
  { id: 'PATCH /files/:id', method: 'patch', path: '/api/v1/files/{file}', body: { name: 'b.txt' } },
  { id: 'DELETE /files/:id', method: 'delete', path: '/api/v1/files/{file}' },
  { id: 'GET /admin/files', method: 'get', path: '/api/v1/admin/files' },
  { id: 'GET /admin/files/:id', method: 'get', path: '/api/v1/admin/files/{file}' },
  { id: 'DELETE /admin/files/:id', method: 'delete', path: '/api/v1/admin/files/{file}' },
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
function verdict(status: number): 'allow' | 'deny' {
  // 401/403/404 는 거부. 404 는 존재 은닉(§10.2)도 포함하므로 거부로 본다.
  // 4xx 중 400/409 는 권한은 통과하고 입력·상태 때문에 실패한 것이므로 '허용'으로 분류한다.
  if (status === 401 || status === 403 || status === 404) return 'deny';
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

  beforeAll(async () => {
    prisma = createPrisma();
    const roleIds = await seedRolesForTenant(prisma, TENANT);
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

    // 매트릭스의 리소스형 열이 평가할 대상. 소유자는 target(어떤 행위자도 아님)이므로
    // 각 역할 행은 "타인 소유 파일"에 대한 판정이 된다 — 관계 축 확장(RT-17) 전까지의 기본 컨텍스트다.
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: target.id, name: 'matrix.txt',
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });
    fileId = file.id;

    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.fileUpload.deleteMany({ where: { tenant_id: TENANT } });
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
          .replace('{file}', fileId);
        const body = JSON.parse(
          JSON.stringify(endpoint.body ?? {}).replace('{memberRole}', memberRoleId),
        );

        let req = request(app.getHttpServer())[endpoint.method](url);
        if (actor.authorization) req = req.set('Authorization', actor.authorization);
        if (endpoint.body) req = req.send(body);
        const res = await req;
        generated[endpoint.id][actor.row] = verdict(res.status);
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

  it('선언된 모든 라우트가 매트릭스에 등록되어 있다 (R-7 — 검증 사각지대 방지)', () => {
    // G-5 는 "권한 선언 누락"을 잡지만 "매트릭스 등록 누락"은 잡지 못한다.
    // 등록하지 않은 라우트는 어떤 회귀도 검출되지 않는 사각지대가 되므로 여기서 기계적으로 막는다.
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
