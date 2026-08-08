import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ResourceGrantService } from '../authorization/resource-grant.service';
import { StorageService } from '../storage/storage.service';
import { UploadSessionService } from '../storage/upload-session.service';
import { PrismaGrantStore } from '../authorization/grant.store';
import { statusesAllowing } from '../authorization/authorization.service';
import { SubjectSnapshot } from '../authorization/types';
import { FileSummary, toFileSummary } from './file.serializer';

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly grants: ResourceGrantService,
    private readonly storage: StorageService,
    private readonly uploads: UploadSessionService,
    private readonly grantStore: PrismaGrantStore,
  ) {}

  // ── FILE-1 업로드 ─────────────────────────────────────────────
  async createUploadUrl(subject: SubjectSnapshot, input: { mimeType: string; sizeBytes: number }) {
    return this.uploads.issue({
      tenantId: subject.tenantId,
      requesterId: subject.id,
      contentType: input.mimeType,
      contentLength: input.sizeBytes,
    });
  }

  /** 완료 콜백: 세션 검증 → 오브젝트 확인 → files 행 생성. checksum 불일치 시 오브젝트도 정리한다 */
  async completeUpload(
    subject: SubjectSnapshot,
    input: { uploadId: string; checksum: string; name: string },
  ): Promise<FileSummary> {
    const completed = await this.uploads.complete({
      uploadId: input.uploadId,
      requesterId: subject.id,
      checksum: input.checksum,
    });

    const file = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.file.create({
        data: {
          tenant_id: subject.tenantId,
          owner_id: subject.id,
          name: input.name,
          storage_key: completed.storageKey,
          size_bytes: BigInt(completed.sizeBytes),
          mime_type: completed.mimeType,
          checksum: input.checksum,
        },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId,
        actorId: subject.id,
        action: 'file.upload',
        targetType: 'file',
        targetId: created.id,
        detail: { before: {}, after: { name: created.name, sizeBytes: completed.sizeBytes } },
      });
      return created;
    });
    return toFileSummary(file, subject.id);
  }

  // ── FILE-2/3 목록 (컬렉션 규약, 기획서 §7.3) ──────────────────
  /**
   * 회원용 목록: 게이트는 인증뿐이고 **행 범위를 여기서 강제**한다.
   *
   * 쿼리 조건은 평가기 **0~4단계 전체와 등가**여야 한다(기획서 v1.8 §7.3-2):
   *  - 0단계(주체 상태)는 Guard 가 이미 통과시켰다
   *  - 1단계(리소스 상태): `status='ACTIVE' AND deleted_at IS NULL`
   *  - 2단계(DENY 우선): 유효한 DENY Grant 가 있으면 제외 — **3·4단계만 재현하면 여기가 샌다**
   *  - 3단계(owned): 소유자
   *  - 4단계(Grant): 만료되지 않은 ALLOW Grant 보유
   */
  async listVisible(subject: SubjectSnapshot, page = 1, size = 20): Promise<{ items: FileSummary[]; total: number }> {
    const take = Math.min(Math.max(size, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;

    // Grant 조회는 전용 통로(GrantStore)를 경유한다 — 만료 판정 규칙이 평가기와 한 곳에서 관리되고,
    // G-2 의 "resource_grants 직접 접근 금지" 룰을 느슨하게 하지 않아도 된다.
    const validGrants = await this.grantStore.findSubjectGrants(subject.id, 'file');
    const allowIds = new Set(validGrants.filter((g) => g.effect === 'ALLOW').map((g) => g.resourceId));
    const denyIds = new Set(validGrants.filter((g) => g.effect === 'DENY').map((g) => g.resourceId));
    // DENY 는 소유자 경로보다 우선한다(INV-4) — 소유 파일이어도 DENY 가 걸리면 제외한다
    for (const id of denyIds) allowIds.delete(id);

    const where: Prisma.FileWhereInput = {
      tenant_id: subject.tenantId,
      // 1단계 게이트를 손으로 옮겨 적지 않고 평가기의 표에서 가져온다(§15.1)
      status: { in: [...statusesAllowing('file', 'file.read')] },
      deleted_at: null,
      OR: [{ owner_id: subject.id }, { id: { in: [...allowIds] } }],
      ...(denyIds.size > 0 ? { NOT: { id: { in: [...denyIds] } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.file.findMany({ where, orderBy: { created_at: 'desc' }, skip, take }),
      this.prisma.file.count({ where }),
    ]);
    return { items: rows.map((f) => toFileSummary(f, subject.id)), total };
  }

  /** FILE-7 관리자 전체 목록 — `/admin/files` 라우트에서 `file.read.all` 로 게이트한다 */
  async listAll(subject: SubjectSnapshot, page = 1, size = 20): Promise<{ items: FileSummary[]; total: number }> {
    const take = Math.min(Math.max(size, 1), 100);
    const where: Prisma.FileWhereInput = { tenant_id: subject.tenantId, deleted_at: null };
    const [rows, total] = await Promise.all([
      this.prisma.file.findMany({
        where, orderBy: { created_at: 'desc' }, skip: (Math.max(page, 1) - 1) * take, take,
      }),
      this.prisma.file.count({ where }),
    ]);
    return { items: rows.map((f) => toFileSummary(f, subject.id)), total };
  }

  // ── FILE-2 다운로드 ───────────────────────────────────────────
  /**
   * 다운로드 URL 발급. Guard 가 이미 `can(file.read, resource)` 를 통과시킨 뒤에만 호출된다.
   * 발급 자체를 감사에 남긴다 — 서명 URL 은 발급 후 서버를 거치지 않으므로, 이 기록이 유일한 추적점이다.
   */
  async createDownloadUrl(subject: SubjectSnapshot, fileId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.deleted_at) throw new NotFoundException();

    const url = await this.storage.createDownloadUrl({ storageKey: file.storage_key, fileName: file.name });
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.audit.record(tx, {
        tenantId: subject.tenantId,
        actorId: subject.id,
        action: 'file.download.url',
        targetType: 'file',
        targetId: file.id,
        detail: { before: {}, after: { ttlSeconds: 60 } },
      });
    });
    return { url, expiresInSeconds: 60 };
  }

  async detail(fileId: string, viewerId: string): Promise<FileSummary> {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.deleted_at) throw new NotFoundException();
    return toFileSummary(file, viewerId);
  }

  async rename(subject: SubjectSnapshot, fileId: string, name?: string): Promise<FileSummary> {
    if (!name) throw new BadRequestException('변경할 내용이 없습니다.');
    const before = await this.detail(fileId, subject.id);
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.file.update({ where: { id: fileId }, data: { name } });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'file.update',
        targetType: 'file', targetId: fileId,
        detail: { before: { name: before.name }, after: { name } },
      });
    });
    return this.detail(fileId, subject.id);
  }

  // ── FILE-6 삭제 ───────────────────────────────────────────────
  /**
   * 소프트 삭제(§5.3). **`status='DELETED'` 와 `deleted_at` 을 동시에 설정**한다 —
   * 평가기 1단계는 status 만 보고 로더는 deleted_at 을 보므로, 한쪽만 채우면 두 축이 어긋난다(WT-25).
   * 해당 파일을 가리키는 Grant 는 감사 기록과 함께 정리한다(§5.3, CR-3).
   */
  async softDelete(subject: SubjectSnapshot, fileId: string): Promise<void> {
    const file = await this.prisma.file.findUnique({ where: { id: fileId } });
    if (!file || file.deleted_at) throw new NotFoundException();

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.file.update({
        where: { id: fileId },
        data: { status: 'DELETED', deleted_at: new Date() },
      });
      await this.grants.cleanupForResource(tx, 'file', fileId, {
        tenantId: subject.tenantId, actorId: subject.id,
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'file.delete',
        targetType: 'file', targetId: fileId,
        detail: { before: { status: file.status }, after: { status: 'DELETED' } },
      });
    });
    // 스토리지 오브젝트는 보존 기간 경과 후 퍼지 배치가 삭제한다(WP-15 산출물) —
    // 즉시 삭제하면 오삭제 복구가 불가능해진다.
  }

  /**
   * 소유자 삭제 시 그 회원이 소유한 파일 처리 (기획서 MEM-6, WT-17).
   * 보유 수에 비례하는 무제한 쓰기를 한 트랜잭션에 넣지 않도록 상한을 둔다.
   */
  async softDeleteOwnedBy(
    tx: Prisma.TransactionClient,
    ownerId: string,
    context: { tenantId: string; actorId: string | null },
    limit = 500,
  ): Promise<{ processed: number; remaining: number }> {
    const targets = await tx.file.findMany({
      where: { owner_id: ownerId, deleted_at: null },
      select: { id: true },
      take: limit,
    });
    for (const t of targets) {
      await tx.file.update({
        where: { id: t.id },
        data: { status: 'DELETED', deleted_at: new Date() },
      });
      await this.grants.cleanupForResource(tx, 'file', t.id, context);
    }
    const remaining = await tx.file.count({ where: { owner_id: ownerId, deleted_at: null } });
    return { processed: targets.length, remaining };
  }
}
