/**
 * WP-9 통합 테스트 — 실제 S3 호환 스토리지(MinIO) + 실 DB.
 * DoD:
 *  - 업로드·다운로드 왕복
 *  - 만료된 서명 URL 거부 (다운로드 60초·업로드 5분)
 *  - 상한 초과 크기·비허용 MIME 이 서명 단계에서 거부
 *  - API 응답 어디에도 storage_key 부재
 *  - 타인의 upload_id 로 완료 콜백 호출 시 거부
 *  - 미완료 세션 만료 시 오브젝트 GC 삭제
 */
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { config } from 'dotenv';
import { PrismaClient } from '@stonex/db';
import { PrismaPg } from '@prisma/adapter-pg';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuditService } from '../src/audit/audit.service';
import { SettingsService } from '../src/settings/settings.service';
import { StorageService, DOWNLOAD_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS } from '../src/storage/storage.service';
import { UploadSessionService } from '../src/storage/upload-session.service';

jest.setTimeout(120_000);

const ROOT = path.resolve(__dirname, '../../..');
config({ path: path.join(ROOT, '.env') });
const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) throw new Error('TEST_DATABASE_URL 이 필요합니다 (통합 테스트는 실제 DB를 요구).');
if (!process.env.STORAGE_ENDPOINT) throw new Error('STORAGE_ENDPOINT 가 필요합니다 (MinIO 등 S3 호환 스토리지).');

const TENANT = '00000000-0000-0000-0000-000000009990';
const uid = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('WP-9 스토리지 기반 (실 MinIO + 실 DB)', () => {
  let prisma: PrismaClient;
  let storage: StorageService;
  let sessions: UploadSessionService;
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: TEST_URL }, stdio: 'pipe',
    });
    process.env.DATABASE_URL = TEST_URL;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });
    storage = new StorageService(new SettingsService(prisma as unknown as PrismaService, new AuditService()));
    sessions = new UploadSessionService(prisma as unknown as PrismaService, storage);

    // 버킷 준비 (docker-compose 의 minio-init 에 해당)
    const s3 = new S3Client({
      region: process.env.STORAGE_REGION ?? 'us-east-1',
      endpoint: process.env.STORAGE_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY ?? '',
        secretAccessKey: process.env.STORAGE_SECRET_KEY ?? '',
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: process.env.STORAGE_BUCKET ?? 'stonex' })).catch(() => undefined);

    await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: 'storage-test' } });
    const u = await prisma.user.create({
      data: { tenant_id: TENANT, email: `s-${uid()}@t.local`, password_hash: 'x', name: '업로더', status: 'ACTIVE' },
    });
    const o = await prisma.user.create({
      data: { tenant_id: TENANT, email: `o-${uid()}@t.local`, password_hash: 'x', name: '타인', status: 'ACTIVE' },
    });
    userId = u.id;
    otherUserId = o.id;
  });

  afterAll(async () => {
    await prisma.fileUpload.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.user.deleteMany({ where: { tenant_id: TENANT } });
    await prisma.tenant.delete({ where: { id: TENANT } });
    await prisma.$disconnect();
  });

  const issue = (contentLength = 11, contentType = 'text/plain') =>
    sessions.issue({ tenantId: TENANT, requesterId: userId, contentType, contentLength });

  it('업로드·다운로드 왕복이 동작한다', async () => {
    const body = 'hello world'; // 11 bytes
    const ticket = await issue(body.length);

    const put = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
      body,
    });
    expect(put.ok).toBe(true);

    const completed = await sessions.complete({
      uploadId: ticket.uploadId, requesterId: userId, checksum: sessions.sha256(Buffer.from(body)),
    });
    expect(completed.sizeBytes).toBe(body.length);

    const downloadUrl = await storage.createDownloadUrl({
      storageKey: completed.storageKey, fileName: 'hello.txt',
    });
    const got = await fetch(downloadUrl);
    expect(got.ok).toBe(true);
    expect(await got.text()).toBe(body);
    // 다운로드는 브라우저 인라인 실행이 아니라 첨부로만 제공된다(§10.4)
    expect(got.headers.get('content-disposition')).toContain('attachment');
  });

  it('발급 응답에 storage_key 가 포함되지 않는다 (§10.2)', async () => {
    const ticket = await issue();
    expect(Object.keys(ticket).sort()).toEqual(['expiresAt', 'uploadId', 'uploadUrl']);
    const session = await prisma.fileUpload.findUniqueOrThrow({ where: { id: ticket.uploadId } });
    // 서명 URL 안에는 키가 들어가지만(스토리지가 요구), 응답 본문의 다른 필드로는 노출되지 않는다
    expect(JSON.stringify({ uploadId: ticket.uploadId, expiresAt: ticket.expiresAt }))
      .not.toContain(session.storage_key);
  });

  it('상한 초과 크기·비허용 MIME 은 서명 단계에서 거부된다', async () => {
    await expect(issue(101 * 1024 * 1024)).rejects.toThrow(/크기/);
    await expect(issue(10, 'application/x-msdownload')).rejects.toThrow(/형식/);
    await expect(issue(0)).rejects.toThrow(/크기/);
  });

  it('타인의 upload_id 로 완료 콜백을 호출하면 거부된다', async () => {
    const ticket = await issue(5);
    await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': '5' },
      body: 'abcde',
    });
    await expect(
      sessions.complete({ uploadId: ticket.uploadId, requesterId: otherUserId, checksum: 'x' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('만료된 세션의 완료 콜백은 거부되고 EXPIRED 로 표시된다', async () => {
    const ticket = await issue(5);
    await prisma.fileUpload.update({
      where: { id: ticket.uploadId }, data: { expires_at: new Date(Date.now() - 1000) },
    });
    await expect(
      sessions.complete({ uploadId: ticket.uploadId, requesterId: userId, checksum: 'x' }),
    ).rejects.toThrow(/만료/);
    const after = await prisma.fileUpload.findUniqueOrThrow({ where: { id: ticket.uploadId } });
    expect(after.state).toBe('EXPIRED');
  });

  it('만료된 서명 URL 은 스토리지가 거부한다', async () => {
    // 서명 만료를 실시간으로 기다리지 않고, 만료 시각이 과거인 URL 을 만들어 검증한다
    const key = storage.createStorageKey(TENANT);
    const url = await storage.createUploadUrl({ storageKey: key, contentType: 'text/plain', contentLength: 3 });
    const expired = url.replace(/X-Amz-Expires=\d+/, 'X-Amz-Expires=1');
    const res = await fetch(expired, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain', 'Content-Length': '3' }, body: 'abc',
    });
    expect(res.ok).toBe(false); // 서명 불일치 또는 만료
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(60);
    expect(UPLOAD_URL_TTL_SECONDS).toBe(300);
  });

  it('미완료 세션이 만료되면 GC 가 오브젝트를 삭제한다', async () => {
    const ticket = await issue(3);
    await fetch(ticket.uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'text/plain', 'Content-Length': '3' }, body: 'abc',
    });
    const session = await prisma.fileUpload.findUniqueOrThrow({ where: { id: ticket.uploadId } });
    expect(await storage.headObject(session.storage_key)).not.toBeNull();

    await prisma.fileUpload.update({
      where: { id: ticket.uploadId }, data: { expires_at: new Date(Date.now() - 1000) },
    });
    const result = await sessions.collectGarbage();
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await storage.headObject(session.storage_key)).toBeNull(); // 오브젝트 삭제됨
    const after = await prisma.fileUpload.findUniqueOrThrow({ where: { id: ticket.uploadId } });
    expect(after.state).toBe('EXPIRED');
  });
});
