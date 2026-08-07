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

    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
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
          .replace('{memberRole}', memberRoleId);
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

  it('@Public 선언 목록과 비인증 행이 1:1 로 대응한다 (RT-5)', async () => {
    const golden = readGolden();
    const anonymousAllowed = Object.entries(golden)
      .filter(([, row]) => row.anonymous === 'allow')
      .map(([id]) => id);
    // 현재 공개 API 는 헬스체크뿐이다. 보호 API 가 실수로 @Public 이 되면 이 목록이 늘어난다
    expect(anonymousAllowed).toEqual(['GET /health']);
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
