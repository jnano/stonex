/**
 * G-1 **관계 축** 매트릭스 (작업지시서 WP-15-4, RT-17·WT-14).
 *
 * 역할 축만으로는 Phase 2 API 를 검증할 수 없다. 같은 `MEMBER` 라도 대상 리소스와의 **관계**에
 * 따라 결과가 갈리기 때문이다 — 소유자인지, 남남인지, 공유받았는지, 그 공유가 만료됐는지,
 * 차단(DENY)됐는지. 역할 축 골든(`matrix.yaml`)은 픽스처가 우연히 고른 관계 하나만 박제하므로
 * 그 축에서의 회귀 검출력은 사실상 0이다.
 *
 * 여기서는 **셀마다 전용 픽스처를 새로 만든다.** 공용 픽스처를 재사용하면 앞선 요청의 성공이
 * 뒤 셀의 대상을 소멸시켜(삭제 라우트) 실행 순서가 판정을 오염시킨다 — WP-12·13에서 실제로 겪었다.
 *
 * 갱신: UPDATE_MATRIX=1 pnpm --filter @stonex/api exec jest test/g1-relations.spec.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@stonex/db';
import { TokenService } from '../src/auth/token.service';
import { createPrisma, createTestApp, uid } from './support/test-app';
import { RowActor, createActorForRole, seedRolesForTenant } from './support/matrix-fixture';
import { ROLES } from '../../../db/seeds/permissions';

jest.setTimeout(300_000);

const GOLDEN_PATH = path.resolve(__dirname, '../../../governance/matrix-relations.yaml');
const TENANT = '00000000-0000-0000-0000-000000009981';

/** 대상 리소스와 행위자의 관계 — Phase 2 판정이 갈리는 축 */
const RELATIONS = ['owner', 'stranger', 'grantee_allow', 'grantee_expired', 'grantee_deny'] as const;
type Relation = (typeof RELATIONS)[number];

/**
 * 관계에 따라 결과가 갈리는 **리소스형 라우트만** 싣는다.
 * 목록·생성 라우트는 대상 리소스가 없어 이 축이 성립하지 않으므로 역할 축 골든이 담당한다.
 */
const ENDPOINTS: Array<{
  id: string; method: 'get' | 'post' | 'patch' | 'delete'; kind: 'file' | 'domain';
  path: (id: string) => string; body?: object;
}> = [
  { id: 'GET /files/:id', method: 'get', kind: 'file', path: (id) => `/api/v1/files/${id}` },
  { id: 'GET /files/:id/download-url', method: 'get', kind: 'file', path: (id) => `/api/v1/files/${id}/download-url` },
  { id: 'PATCH /files/:id', method: 'patch', kind: 'file', path: (id) => `/api/v1/files/${id}`, body: { name: 'x.txt' } },
  { id: 'DELETE /files/:id', method: 'delete', kind: 'file', path: (id) => `/api/v1/files/${id}` },
  { id: 'GET /files/:id/shares', method: 'get', kind: 'file', path: (id) => `/api/v1/files/${id}/shares` },
  { id: 'GET /domains/:id', method: 'get', kind: 'domain', path: (id) => `/api/v1/domains/${id}` },
  { id: 'PATCH /domains/:id', method: 'patch', kind: 'domain', path: (id) => `/api/v1/domains/${id}`, body: { fqdn: 'rel-edit.example.com' } },
  { id: 'POST /domains/:id/verify', method: 'post', kind: 'domain', path: (id) => `/api/v1/domains/${id}/verify` },
  { id: 'DELETE /domains/:id', method: 'delete', kind: 'domain', path: (id) => `/api/v1/domains/${id}` },
  { id: 'GET /domains/:id/delegations', method: 'get', kind: 'domain', path: (id) => `/api/v1/domains/${id}/delegations` },
];

type Matrix = Record<string, Record<string, string>>;

function verdict(status: number, context: string): 'allow' | 'deny' {
  if (status === 401 || status === 403 || status === 404) return 'deny';
  if (status === 429 || status >= 500) {
    throw new Error(`관계 매트릭스 판정 불가(${status}): ${context}`);
  }
  return 'allow';
}

describe('G-1 관계 축 매트릭스', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let actors: RowActor[];
  let outsiderId: string;
  let readPermIds: Record<'file' | 'domain', string>;

  beforeAll(async () => {
    prisma = createPrisma();
    const roleIds = await seedRolesForTenant(prisma, TENANT);
    const tokens = new TokenService();
    actors = [];
    for (const role of ROLES.map((r) => r.code)) {
      actors.push(await createActorForRole(prisma, tokens, TENANT, role, roleIds));
    }
    // 리소스의 "남" 소유자. 어떤 행위자도 아니어야 stranger 관계가 성립한다
    outsiderId = (await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `outsider-${uid()}@t.local`, password_hash: 'x',
        name: '외부 소유자', status: 'ACTIVE',
      },
    })).id;
    readPermIds = {
      file: (await prisma.permission.findUniqueOrThrow({ where: { code: 'file.read' } })).id,
      domain: (await prisma.permission.findUniqueOrThrow({ where: { code: 'domain.read' } })).id,
    };
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.domainTransfer.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domainVerificationAttempt.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.governanceFreeze.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domain.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.file.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.userRole.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.rolePermission.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.role.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  /** 셀 전용 리소스를 새로 만든다 — 앞선 셀의 삭제가 뒤 셀을 오염시키지 않도록 */
  async function makeResource(kind: 'file' | 'domain', actorId: string, relation: Relation): Promise<string> {
    const ownerId = relation === 'owner' ? actorId : outsiderId;
    const resourceId = kind === 'file'
      ? (await prisma.file.create({
          data: {
            tenant_id: TENANT, owner_id: ownerId, name: `rel-${uid()}.txt`,
            storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
          },
        })).id
      : (await prisma.domain.create({
          data: {
            tenant_id: TENANT, owner_id: ownerId,
            fqdn: `rel-${uid()}.example.com`, status: 'UNVERIFIED',
          },
        })).id;

    if (relation === 'grantee_allow' || relation === 'grantee_expired' || relation === 'grantee_deny') {
      await prisma.resourceGrant.create({
        data: {
          tenant_id: TENANT, subject_id: actorId, resource_type: kind, resource_id: resourceId,
          permission_id: readPermIds[kind],
          effect: relation === 'grantee_deny' ? 'DENY' : 'ALLOW',
          granted_by: outsiderId,
          expires_at: relation === 'grantee_expired' ? new Date(Date.now() - 60_000) : null,
        },
      });
    }
    return resourceId;
  }

  it('역할 × 관계 매트릭스가 골든 파일과 일치한다', async () => {
    const generated: Matrix = {};

    for (const endpoint of ENDPOINTS) {
      generated[endpoint.id] = {};
      for (const actor of actors) {
        for (const relation of RELATIONS) {
          const resourceId = await makeResource(endpoint.kind, actor.userId as string, relation);
          let req = request(app.getHttpServer())[endpoint.method](endpoint.path(resourceId));
          req = req.set('Authorization', actor.authorization as string);
          if (endpoint.body) req = req.send(endpoint.body);
          const res = await req;
          generated[endpoint.id][`${actor.row}/${relation}`] =
            verdict(res.status, `${endpoint.id} / ${actor.row} / ${relation}`);
        }
      }
    }

    if (process.env.UPDATE_MATRIX === '1') {
      writeGolden(generated);
      console.log('관계 축 골든 파일을 갱신했습니다.');
      return;
    }
    expect(generated).toEqual(readGolden());
  });

  it('관계 축이 실제로 판정을 가른다 — 축을 넣은 이유의 자기 검증', () => {
    const golden = readGolden();
    // 모든 라우트에서 모든 관계가 같은 값이면 이 축은 아무것도 검증하지 못한다.
    // 최소 한 라우트에서는 관계에 따라 값이 갈려야 한다.
    const varying = Object.entries(golden).filter(([, row]) => new Set(Object.values(row)).size > 1);
    expect(varying.length).toBeGreaterThan(0);

    // 그리고 **만료·DENY 는 ALLOW 와 달라야 한다** — 이 셋이 같으면 만료·차단이 무력화된 것이다
    for (const [id, row] of Object.entries(golden)) {
      for (const role of ROLES.map((r) => r.code)) {
        const allow = row[`${role}/grantee_allow`];
        const expired = row[`${role}/grantee_expired`];
        const deny = row[`${role}/grantee_deny`];
        if (allow === 'allow') {
          expect({ id, role, expired }).toEqual({ id, role, expired: 'deny' });
          expect({ id, role, deny }).toEqual({ id, role, deny: 'deny' });
        }
      }
    }
  });
});

function readGolden(): Matrix {
  const raw = fs.readFileSync(GOLDEN_PATH, 'utf8');
  const start = raw.indexOf('matrix:');
  if (start < 0) throw new Error('골든 파일에 matrix 섹션이 없습니다. UPDATE_MATRIX=1 로 생성하세요.');
  const out: Matrix = {};
  let current = '';
  for (const line of raw.slice(start).split('\n').slice(1)) {
    if (!line.trim()) continue;
    const routeMatch = /^ {2}"(.+)":$/.exec(line);
    if (routeMatch) {
      current = routeMatch[1];
      out[current] = {};
      continue;
    }
    const cellMatch = /^ {4}(.+): (allow|deny)$/.exec(line);
    if (cellMatch && current) out[current][cellMatch[1]] = cellMatch[2];
  }
  return out;
}

function writeGolden(matrix: Matrix): void {
  const lines = [
    '# G-1 관계 축 매트릭스 (자동 생성 — 직접 편집 금지)',
    '#',
    '# 열 이름은 `역할/관계` 다. 같은 역할이라도 대상 리소스와의 관계에 따라 판정이 갈리므로,',
    '# 역할 축만 있는 matrix.yaml 로는 Phase 2 API 의 회귀를 잡을 수 없다(RT-17·WT-14).',
    '#',
    '# 갱신: UPDATE_MATRIX=1 pnpm --filter @stonex/api exec jest test/g1-relations.spec.ts',
    'matrix:',
  ];
  for (const [route, row] of Object.entries(matrix)) {
    lines.push(`  "${route}":`);
    for (const [cell, value] of Object.entries(row)) lines.push(`    ${cell}: ${value}`);
  }
  fs.writeFileSync(GOLDEN_PATH, `${lines.join('\n')}\n`);
}
