import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { UploadSessionService, UploadTicket } from '../storage/upload-session.service';
import { SubjectSnapshot } from '../authorization/types';
import { BoardsService } from './boards.service';
import { isImageMime, reencodeImage } from './image-guard';

export interface AttachmentResult {
  fileId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  /** 표시·다운로드용 서명 URL (만료 있음). 이미지는 inline, 그 외는 attachment.
   *  storage_key 는 응답에 싣지 않는다(§10.2) — URL 만 나간다 */
  url?: string;
}

/** 글당 첨부 상한 — 무제한이면 첨부가 저장 공간 공격 벡터가 된다 */
const MAX_ATTACHMENTS = 10;

/**
 * 게시판 첨부 (WP-B2, 스펙 §7.2 — 코어 file 모듈 재사용).
 *
 * 신규 저장소를 만들지 않는다: 업로드 세션(file_uploads)·파일 행(files)·서명 URL 전부
 * 코어 재사용이고, 게시판 몫은 `post_attachments` 링크뿐이다.
 *
 * 흐름: 드롭 → 세션 발급(게시판 쓰기 권한 확인) → 스토리지 직접 업로드 →
 * **upload_id 만으로 콜백**(R-B7 — storage_key 왕복 금지, requester 대조는 세션이 한다)
 * → 이미지면 재인코딩(EXIF 제거) → file 행 생성 → 글 작성/수정 시 링크.
 */
@Injectable()
export class BoardAttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly uploads: UploadSessionService,
    private readonly boards: BoardsService,
  ) {}

  /** 업로드 세션 발급 — 쓰기 가능한 게시판에서만(canAccessBoard write) */
  async issueUpload(
    subject: SubjectSnapshot,
    boardId: string,
    input: { contentType: string; contentLength: number },
  ): Promise<UploadTicket> {
    await this.boards.loadAccessible(subject, boardId, { write: true });
    return this.uploads.issue({
      tenantId: subject.tenantId,
      requesterId: subject.id,
      contentType: input.contentType,
      contentLength: input.contentLength,
    });
  }

  /**
   * 업로드 완료 콜백. 콜백 입력은 **upload_id 와 checksum 뿐**이다(R-B7) —
   * storage_key 는 세션이 알고 있고, requester 불일치는 세션 완료가 403 으로 끊는다.
   */
  async completeUpload(
    subject: SubjectSnapshot,
    input: { uploadId: string; checksum: string; name: string },
  ): Promise<AttachmentResult> {
    const completed = await this.uploads.complete({
      uploadId: input.uploadId,
      requesterId: subject.id,
      checksum: input.checksum,
    });

    let sizeBytes = completed.sizeBytes;
    let checksum = input.checksum;
    if (isImageMime(completed.mimeType)) {
      // 이미지는 재인코딩을 통과해야 첨부다 — EXIF 제거·형식 이중검증·해상도 상한(image-guard)
      const original = await this.storage.getObjectBuffer(completed.storageKey);
      const clean = await reencodeImage(original, completed.mimeType);
      await this.storage.putObjectBuffer(completed.storageKey, clean, completed.mimeType);
      sizeBytes = clean.length;
      checksum = this.uploads.sha256(clean); // 파일 행의 체크섬은 재인코딩 결과 기준
    }

    const file = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.file.create({
        data: {
          tenant_id: subject.tenantId,
          owner_id: subject.id,
          name: input.name,
          storage_key: completed.storageKey,
          size_bytes: BigInt(sizeBytes),
          mime_type: completed.mimeType,
          checksum,
        },
      });
      await this.audit.record(tx, {
        tenantId: subject.tenantId, actorId: subject.id, action: 'board.attachment.upload',
        targetType: 'file', targetId: created.id,
        detail: { before: {}, after: { name: created.name, sizeBytes, reencoded: isImageMime(completed.mimeType) } },
      });
      return created;
    });
    return { fileId: file.id, name: file.name, sizeBytes, mimeType: file.mime_type };
  }

  /**
   * 글에 첨부 링크. **본인 소유 파일만** 연결할 수 있다 — 타인 fileId 를 지목해
   * 남의 파일을 자기 글에 노출하는 경로를 끊는다. 트랜잭션은 호출자(글 작성/수정)의 것.
   */
  async linkToPost(
    tx: Prisma.TransactionClient,
    subject: SubjectSnapshot,
    postId: string,
    fileIds: string[],
  ): Promise<void> {
    const unique = [...new Set(fileIds)];
    if (unique.length === 0) return;
    if (unique.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(`첨부는 글당 ${MAX_ATTACHMENTS}개까지입니다.`);
    }
    const owned = await tx.file.findMany({
      where: { id: { in: unique }, owner_id: subject.id, tenant_id: subject.tenantId, deleted_at: null },
      select: { id: true },
    });
    if (owned.length !== unique.length) {
      // 어느 것이 남의 것인지 알려주지 않는다 — 존재 오라클 차단(§10.2)
      throw new BadRequestException('첨부할 수 없는 파일이 포함되어 있습니다.');
    }
    await tx.postAttachment.deleteMany({ where: { post_id: postId } });
    await tx.postAttachment.createMany({
      data: unique.map((fileId, index) => ({ post_id: postId, file_id: fileId, sort_order: index })),
    });
  }

  /**
   * 글의 첨부 목록 — **표시용 서명 URL 을 함께 준다**(WP-B6).
   *
   * 이전에는 이름·크기만 줘서 화면이 첨부를 클릭해도 아무 일이 없었다. 이미지는
   * inline URL 로 본문에 바로 띄우고, 그 외는 다운로드 URL 을 건다.
   */
  async listForPost(postId: string): Promise<AttachmentResult[]> {
    const links = await this.prisma.postAttachment.findMany({
      where: { post_id: postId },
      orderBy: { sort_order: 'asc' },
    });
    if (links.length === 0) return [];
    const files = await this.prisma.file.findMany({
      where: { id: { in: links.map((l) => l.file_id) }, deleted_at: null },
    });
    const byId = new Map(files.map((f) => [f.id, f]));
    const ordered = links
      .map((l) => byId.get(l.file_id))
      .filter((f): f is NonNullable<typeof f> => f !== undefined);
    return Promise.all(
      ordered.map(async (f) => ({
        fileId: f.id,
        name: f.name,
        sizeBytes: Number(f.size_bytes),
        mimeType: f.mime_type,
        url: isImageMime(f.mime_type)
          ? await this.storage.createInlineUrl({ storageKey: f.storage_key, contentType: f.mime_type })
          : await this.storage.createDownloadUrl({ storageKey: f.storage_key, fileName: f.name }),
      })),
    );
  }
}
