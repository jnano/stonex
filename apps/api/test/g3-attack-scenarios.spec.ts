/**
 * G-3 공격 시나리오 회귀 (기획서 §14.2, §10.1 차단표).
 *
 * §10.1 표의 각 공격 경로를 시나리오 ID(ATK-n)로 1:1 대응시켜 고정한다.
 * 신규 기능이 기존 공격 경로를 재개방하지 않는지 매 빌드에서 재검증하는 것이 목적이므로,
 * **실제 API 요청**으로 검증한다(서비스 직접 호출은 Guard 우회 여부를 놓친다).
 *
 * Phase 2 이월분은 todo 로 자리를 남긴다 — 조용히 빠지면 커버리지 공백이 보이지 않는다.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@stonex/db';
import { TokenService } from '../src/auth/token.service';
import { createPrisma, createTestApp, uid } from './support/test-app';
import { RowActor, createActorForRole, seedRolesForTenant } from './support/matrix-fixture';

jest.setTimeout(180_000);

const TENANT = '00000000-0000-0000-0000-000000009992';

describe('G-3 공격 시나리오 회귀 (§10.1)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let tokens: TokenService;
  let roleIds: Record<string, string>;
  let operator: RowActor;
  let superAdminA: RowActor;
  let superAdminB: RowActor;
  let member: RowActor;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    prisma = createPrisma();
    roleIds = await seedRolesForTenant(prisma, TENANT);
    tokens = new TokenService();
    operator = await createActorForRole(prisma, tokens, TENANT, 'OPERATOR', roleIds);
    superAdminA = await createActorForRole(prisma, tokens, TENANT, 'SUPER_ADMIN', roleIds);
    superAdminB = await createActorForRole(prisma, tokens, TENANT, 'SUPER_ADMIN', roleIds);
    member = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$executeRaw`DELETE FROM audit.audit_logs WHERE tenant_id = ${TENANT}::uuid`;
    await prisma.refreshToken.deleteMany({ where: { user: { tenant_id: TENANT } } });
    // files·resource_grants 가 users 를 참조하므로 먼저 정리한다(FK RESTRICT)
    await prisma.resourceGrant.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.fileUpload.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.domainTransfer.deleteMany({ where: { tenant_id: TENANT } });
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

  it('ATK-1: 자신에게 높은 역할 부여 → 본인 대상 역할 변경 전면 금지', async () => {
    const res = await http()
      .post(`/api/v1/members/${operator.userId}/roles`)
      .set('Authorization', operator.authorization as string)
      .send({ roleId: roleIds['SUPER_ADMIN'] });
    expect([403, 404]).toContain(res.status);
  });

  it('ATK-2: 강한 권한을 담은 역할을 만들어 취득 → 미보유 Permission 부여 불가 (ADM-3)', async () => {
    // 시드 역할 중 admin.role.manage 보유자는 SUPER_ADMIN(전체 보유)뿐이므로,
    // 이 공격이 성립할 수 있는 유일한 구성인 "역할 관리 권한만 가진 계정"을 실제로 만들어 검증한다.
    // (OPERATOR 는 admin.role.manage 자체가 없어 한 단계 앞에서 이미 막힌다 — 아래에서 함께 확인)
    const blockedEarlier = await http()
      .post('/api/v1/admin/roles')
      .set('Authorization', operator.authorization as string)
      .send({ code: `ATK2A_${uid()}`, name: '공격역할' });
    expect(blockedEarlier.status).toBe(403);

    const roleManagerRole = await prisma.role.create({
      data: { tenant_id: TENANT, code: `ROLE_MGR_${uid()}`, name: '역할관리자' },
    });
    for (const code of ['admin.role.read', 'admin.role.manage', 'member.read']) {
      const perm = await prisma.permission.findUniqueOrThrow({ where: { code } });
      await prisma.rolePermission.create({
        data: { tenant_id: TENANT, role_id: roleManagerRole.id, permission_id: perm.id },
      });
    }
    const attacker = await prisma.user.create({
      data: {
        tenant_id: TENANT, email: `atk2-${uid()}@t.local`, password_hash: 'x', name: 'atk2',
        status: 'ACTIVE', totp_secret: 'SEEDED',
      },
    });
    await prisma.userRole.create({
      data: { tenant_id: TENANT, user_id: attacker.id, role_id: roleManagerRole.id },
    });
    const attackerToken = await tokens.signAccess({
      sub: attacker.id, tenant: TENANT, pv: attacker.perm_version,
    });

    const created = await http()
      .post('/api/v1/admin/roles')
      .set('Authorization', `Bearer ${attackerToken}`)
      .send({ code: `ATK2B_${uid()}`, name: '공격역할' });
    expect(created.status).toBeLessThan(400); // 역할 생성 자체는 권한상 가능

    // 그러나 자신이 보유하지 않은 Permission 은 그 역할에 담을 수 없다(§10.1)
    const res = await http()
      .put(`/api/v1/admin/roles/${created.body.id}/permissions`)
      .set('Authorization', `Bearer ${attackerToken}`)
      .send({ codes: ['system.settings.manage'] });
    expect(res.status).toBe(403);

    const mappings = await prisma.rolePermission.count({ where: { role_id: created.body.id } });
    expect(mappings).toBe(0); // 상승 경로가 실제로 열리지 않았다
  });

  it('ATK-3: 강한 역할을 공모 계정에 부여해 간접 상승 → 부분집합 검사로 차단', async () => {
    const res = await http()
      .post(`/api/v1/members/${member.userId}/roles`)
      .set('Authorization', operator.authorization as string)
      .send({ roleId: roleIds['SUPER_ADMIN'] });
    expect([403, 404]).toContain(res.status);

    const holds = await prisma.userRole.count({
      where: { user_id: member.userId as string, role_id: roleIds['SUPER_ADMIN'] },
    });
    expect(holds).toBe(0);
  });

  it('ATK-4: 동급 관리자 계정 정지 후 역할 탈취 → 동집합 우위 검사로 차단', async () => {
    const res = await http()
      .post(`/api/v1/members/${superAdminB.userId}/ban`)
      .set('Authorization', superAdminA.authorization as string);
    expect([403, 404]).toContain(res.status);

    const target = await prisma.user.findUniqueOrThrow({ where: { id: superAdminB.userId as string } });
    expect(target.status).toBe('ACTIVE'); // 정지되지 않음
  });

  it('ATK-5: 하위 권한자가 상위 관리자 관리 시도 → 우위 검사로 차단', async () => {
    const res = await http()
      .post(`/api/v1/members/${superAdminA.userId}/ban`)
      .set('Authorization', operator.authorization as string);
    expect([403, 404]).toContain(res.status);
  });

  it('ATK-6: 최고관리자 소멸로 시스템 잠금 → 마지막 활성 SUPER_ADMIN 보존', async () => {
    // A 를 제외한 모든 SUPER_ADMIN 을 제거해 "마지막 1명" 상황을 만든다
    await prisma.userRole.deleteMany({
      where: { role_id: roleIds['SUPER_ADMIN'], user_id: superAdminB.userId as string },
    });

    // 남은 1명(A)의 SUPER_ADMIN 역할을 회수 시도 — 회수 주체는 A 자신이 아니어야 하므로
    // 서비스 계층 불변식을 직접 검증한다(본인 대상은 ATK-1 이 이미 막는다)
    const { SuperAdminGuardService } = await import('../src/members/super-admin-guard.service');
    await expect(
      prisma.$transaction(async (tx) => {
        await new SuperAdminGuardService().ensureRemains(tx, superAdminA.userId as string, TENANT);
      }),
    ).rejects.toThrow(/마지막 활성 최고관리자/);

    // 원복
    await prisma.userRole.create({
      data: { tenant_id: TENANT, user_id: superAdminB.userId as string, role_id: roleIds['SUPER_ADMIN'] },
    });
  });

  it('ATK-7: 정지된 계정이 리프레시 토큰으로 세션 유지 → 정지 시 패밀리 폐기 + 갱신 시 상태 재검증', async () => {
    const victim = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    await prisma.refreshToken.create({
      data: {
        user_id: victim.userId as string, token_hash: `atk7-${uid()}`,
        family_id: crypto.randomUUID(), expires_at: new Date(Date.now() + 86_400_000),
      },
    });

    const banned = await http()
      .post(`/api/v1/members/${victim.userId}/ban`)
      .set('Authorization', superAdminA.authorization as string);
    expect(banned.status).toBeLessThan(400);

    // 활성 리프레시 토큰이 남지 않아야 한다
    const alive = await prisma.refreshToken.count({
      where: { user_id: victim.userId as string, revoked_at: null },
    });
    expect(alive).toBe(0);

    // 기존 Access Token 도 즉시 거부된다 (pv 증가)
    const res = await http().get('/api/v1/me').set('Authorization', victim.authorization as string);
    expect(res.status).toBe(401);
  });

  it('ATK-8: 토큰 탈취 후 권한 회수 회피 → JWT 에 권한 미포함 + pv 불일치 거부', async () => {
    const victim = await createActorForRole(prisma, tokens, TENANT, 'OPERATOR', roleIds);
    const before = await http().get('/api/v1/members').set('Authorization', victim.authorization as string);
    expect(before.status).toBe(200);

    // 역할 회수 (탈취자는 여전히 예전 토큰을 들고 있다)
    await http()
      .delete(`/api/v1/members/${victim.userId}/roles/${roleIds['OPERATOR']}`)
      .set('Authorization', superAdminA.authorization as string);

    const after = await http().get('/api/v1/members').set('Authorization', victim.authorization as string);
    expect(after.status).toBe(401); // 토큰 만료를 기다리지 않고 즉시 무효
  });

  it('ATK-9: 온보딩 미완료 관리자가 관리 API 사용 → 온보딩 게이트로 차단 (§8.5)', async () => {
    const pending = await createActorForRole(prisma, tokens, TENANT, 'OPERATOR', roleIds);
    await prisma.user.update({
      where: { id: pending.userId as string },
      data: { totp_enrollment_required: true },
    });

    const res = await http().get('/api/v1/members').set('Authorization', pending.authorization as string);
    expect(res.status).toBe(403);
  });

  it('ATK-10: 감사 로그 변조 → append-only 로 DB 수준 차단 (§10.3)', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE stonex_app');
        await tx.$executeRawUnsafe(`UPDATE audit.audit_logs SET action = 'tampered' WHERE tenant_id = '${TENANT}'`);
      }),
    ).rejects.toThrow(/permission denied|권한/i);
  });

  // ── Phase 2 이월 (기능 도입 시 활성화) ──
  it('ATK-11: 공유받은 파일 재공유로 전파 → 화이트리스트에서 file.share 제외', async () => {
    const owner = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const grantee = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const third = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: owner.userId as string, name: `atk11-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });

    // 소유자가 수령자에게 읽기 공유
    const shared = await http()
      .post(`/api/v1/files/${file.id}/shares`)
      .set('Authorization', owner.authorization as string)
      .send({ subjectId: grantee.userId, permissions: ['file.read'] });
    expect(shared.status).toBeLessThan(400);

    // (a) 소유자조차 file.share 를 Grant 로 넘길 수 없다 — 전파의 원천 차단
    const propagate = await http()
      .post(`/api/v1/files/${file.id}/shares`)
      .set('Authorization', owner.authorization as string)
      .send({ subjectId: grantee.userId, permissions: ['file.share'] });
    expect(propagate.status).toBe(403);

    // (b) 수령자가 제3자에게 재공유를 시도하면 공유 경로 자체가 막힌다(소유자가 아니므로 404)
    const reshare = await http()
      .post(`/api/v1/files/${file.id}/shares`)
      .set('Authorization', grantee.authorization as string)
      .send({ subjectId: third.userId, permissions: ['file.read'] });
    expect([403, 404]).toContain(reshare.status);

    // 제3자는 끝내 접근하지 못한다
    const access = await http()
      .get(`/api/v1/files/${file.id}`)
      .set('Authorization', third.authorization as string);
    expect(access.status).toBe(404);
  });
  it('ATK-13: 위임받은 도메인 재위임으로 전파 → 화이트리스트에서 domain.share 제외', async () => {
    // ATK-11 의 도메인판(작업지시서 WP-13 DoD). 파일과 **같은 Grant 서비스**를 쓰므로
    // 화이트리스트 일반화(`${type}.share` 제외)가 실제로 도메인에도 적용되는지 확인한다.
    const owner = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const grantee = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const third = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const domain = await prisma.domain.create({
      data: {
        tenant_id: TENANT, owner_id: owner.userId as string,
        fqdn: `atk13-${uid()}.example.com`, status: 'UNVERIFIED',
      },
    });

    // 소유자가 수임자에게 운영 위임 (domain.read 는 서비스가 항상 포함)
    const delegated = await http()
      .post(`/api/v1/domains/${domain.id}/delegations`)
      .set('Authorization', owner.authorization as string)
      .send({ subjectId: grantee.userId, permissions: ['domain.update'] });
    expect(delegated.status).toBeLessThan(400);

    // (a) 소유자조차 domain.share 를 Grant 로 넘길 수 없다
    const propagate = await http()
      .post(`/api/v1/domains/${domain.id}/delegations`)
      .set('Authorization', owner.authorization as string)
      .send({ subjectId: grantee.userId, permissions: ['domain.share'] });
    expect(propagate.status).toBe(403);

    // (b) 수임자의 재위임 시도는 위임 경로 자체가 막힌다(소유자가 아니므로 404)
    const redelegate = await http()
      .post(`/api/v1/domains/${domain.id}/delegations`)
      .set('Authorization', grantee.authorization as string)
      .send({ subjectId: third.userId, permissions: ['domain.read'] });
    expect([403, 404]).toContain(redelegate.status);

    // (c) 소유권 이전도 위임 대상이 아니다 — 위임만으로 도메인을 가져갈 수 없다
    const steal = await http()
      .post(`/api/v1/domains/${domain.id}/transfers`)
      .set('Authorization', grantee.authorization as string)
      .send({ toUserId: grantee.userId });
    expect(steal.status).toBe(404);

    // 제3자는 끝내 접근하지 못한다
    const access = await http()
      .get(`/api/v1/domains/${domain.id}`)
      .set('Authorization', third.authorization as string);
    expect(access.status).toBe(404);
  });

  it('ATK-14: 소유권 탈취 — 입력으로 owner_id 를 밀어 넣기 → DTO 화이트리스트로 차단', async () => {
    // 소유자만 통과하는 게이트가 많으므로(owned scope), 입력으로 소유자를 바꿀 수 있으면
    // 공유 수령자가 스스로 소유자가 되어 전 권한을 얻는다.
    const owner = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const attacker = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const domain = await prisma.domain.create({
      data: {
        tenant_id: TENANT, owner_id: owner.userId as string,
        fqdn: `atk14-${uid()}.example.com`, status: 'UNVERIFIED',
      },
    });

    const res = await http()
      .patch(`/api/v1/domains/${domain.id}`)
      .set('Authorization', owner.authorization as string)
      .send({ fqdn: `atk14b-${uid()}.example.com`, owner_id: attacker.userId, status: 'VERIFIED' });
    // 전역 ValidationPipe(forbidNonWhitelisted)가 미지 필드를 거부한다
    expect(res.status).toBe(400);

    const after = await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } });
    expect(after.owner_id).toBe(owner.userId);
    expect(after.status).toBe('UNVERIFIED');
  });

  it('ATK-15: 관리자가 자기 자신에게 Grant 부여 → 자기부여 금지로 차단', async () => {
    // 관리 권한으로 자기 리소스 권한을 늘리는 가장 단순한 경로다.
    const admin = await createActorForRole(prisma, tokens, TENANT, 'SUPER_ADMIN', roleIds);
    const victim = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: victim.userId as string, name: `atk15-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });

    const res = await http()
      .post(`/api/v1/admin/files/${file.id}/shares`)
      .set('Authorization', admin.authorization as string)
      .send({ subjectId: admin.userId, permissions: ['file.read'] });
    expect(res.status).toBe(403);
    expect(await prisma.resourceGrant.count({ where: { resource_id: file.id } })).toBe(0);
  });

  it('ATK-16: 소유권 이전으로 DENY 세탁 → 이전 시 DENY 승계로 차단', async () => {
    // DENY 는 리소스에 걸린 제재다. 이전할 때 함께 지우면 소유권 왕복만으로 제재가 풀린다.
    const owner = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const receiver = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const sanctioned = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const domain = await prisma.domain.create({
      data: {
        tenant_id: TENANT, owner_id: owner.userId as string,
        fqdn: `atk16-${uid()}.example.com`, status: 'UNVERIFIED',
      },
    });
    const readPerm = await prisma.permission.findUniqueOrThrow({ where: { code: 'domain.read' } });
    await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: sanctioned.userId as string, resource_type: 'domain',
        resource_id: domain.id, permission_id: readPerm.id, effect: 'DENY',
        granted_by: owner.userId as string,
      },
    });

    const proposed = await http()
      .post(`/api/v1/domains/${domain.id}/transfers`)
      .set('Authorization', owner.authorization as string)
      .send({ toUserId: receiver.userId });
    expect(proposed.status).toBeLessThan(400);

    const accepted = await http()
      .post(`/api/v1/transfers/${proposed.body.id}/accept`)
      .set('Authorization', receiver.authorization as string);
    expect(accepted.status).toBeLessThan(400);

    // 소유자는 바뀌었지만 제재는 남는다
    const remaining = await prisma.resourceGrant.findMany({ where: { resource_id: domain.id } });
    expect(remaining.map((g) => g.effect)).toEqual(['DENY']);
    const access = await http()
      .get(`/api/v1/domains/${domain.id}`)
      .set('Authorization', sanctioned.authorization as string);
    expect(access.status).toBe(404);
  });

  it('ATK-17: DENY 를 정상 공유 요청으로 덮어쓰기 → 409 로 차단', async () => {
    // UNIQUE 가 effect 를 제외하므로 UPSERT 로 구현하면 DENY 가 조용히 ALLOW 로 바뀐다.
    const owner = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const sanctioned = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: owner.userId as string, name: `atk17-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });
    const readPerm = await prisma.permission.findUniqueOrThrow({ where: { code: 'file.read' } });
    const deny = await prisma.resourceGrant.create({
      data: {
        tenant_id: TENANT, subject_id: sanctioned.userId as string, resource_type: 'file',
        resource_id: file.id, permission_id: readPerm.id, effect: 'DENY',
        granted_by: owner.userId as string,
      },
    });

    const res = await http()
      .post(`/api/v1/files/${file.id}/shares`)
      .set('Authorization', owner.authorization as string)
      .send({ subjectId: sanctioned.userId, permissions: ['file.read'] });
    expect(res.status).toBe(409);

    const after = await prisma.resourceGrant.findUniqueOrThrow({ where: { id: deny.id } });
    expect(after.effect).toBe('DENY');
  });

  it('ATK-12: 소프트 삭제된 리소스 접근 → 평가기 1단계 리소스 상태 게이트', async () => {
    // 소유자가 자기 파일을 삭제한 뒤에도 접근할 수 있으면, 삭제가 접근 통제상 무의미해진다.
    const owner = await createActorForRole(prisma, tokens, TENANT, 'MEMBER', roleIds);
    const file = await prisma.file.create({
      data: {
        tenant_id: TENANT, owner_id: owner.userId as string, name: `atk12-${uid()}.txt`,
        storage_key: `${TENANT}/${uid()}`, size_bytes: 1n, mime_type: 'text/plain', checksum: 'c',
      },
    });

    // 삭제 전에는 소유자로서 접근 가능
    const before = await http()
      .get(`/api/v1/files/${file.id}`)
      .set('Authorization', owner.authorization as string);
    expect(before.status).toBe(200);

    const removed = await http()
      .delete(`/api/v1/files/${file.id}`)
      .set('Authorization', owner.authorization as string);
    expect(removed.status).toBeLessThan(400);

    // 삭제 후에는 소유자여도 차단된다(존재 은닉이므로 404)
    for (const path of [`/api/v1/files/${file.id}`, `/api/v1/files/${file.id}/download-url`]) {
      const res = await http().get(path).set('Authorization', owner.authorization as string);
      expect(res.status).toBe(404);
    }

    // 목록에도 나타나지 않는다 (컬렉션 등가성 — 3·4단계만 재현하면 여기가 샌다)
    const list = await http().get('/api/v1/files').set('Authorization', owner.authorization as string);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(file.id);
  });
});
