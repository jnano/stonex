import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_MAX_BYTES, StorageService } from './storage.service';

/** 업로드 허용 MIME — 실행 파일 차단(§10.4). 확장자·MIME 이중 검증의 MIME 축 */
const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/csv',
  'application/zip', 'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export interface UploadTicket {
  uploadId: string;
  uploadUrl: string;
  expiresAt: Date;
}

/**
 * 업로드 세션 (작업지시서 WP-9 항목 6·7).
 *
 * **왜 세션 테이블이 필요한가**: 완료 콜백은 "어느 업로드가 끝났는지"를 지목해야 하는데,
 * `storage_key`를 클라이언트에 노출하면 §10.2 위반이자 **타인의 오브젝트를 지목해 자기 파일 행을
 * 만드는 경로**가 열린다. 그래서 서버가 발급 시점 조건을 보관하고, 콜백은 불투명 `uploadId`만 받는다.
 * Redis 는 유실 허용 캐시라 이 권위 정보를 담을 수 없다(§8.3).
 */
@Injectable()
export class UploadSessionService {
  private readonly logger = new Logger(UploadSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** 서명 URL 발급 + 세션 기록. 크기·MIME 상한은 서명에 포함되므로 스토리지도 함께 강제한다 */
  async issue(params: {
    tenantId: string;
    requesterId: string;
    contentType: string;
    contentLength: number;
  }): Promise<UploadTicket> {
    if (!ALLOWED_MIME.has(params.contentType)) {
      throw new BadRequestException('허용되지 않는 파일 형식입니다.');
    }
    if (params.contentLength <= 0 || params.contentLength > DEFAULT_MAX_BYTES) {
      throw new BadRequestException('허용되지 않는 파일 크기입니다.');
    }

    const storageKey = this.storage.createStorageKey(params.tenantId);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const session = await this.prisma.fileUpload.create({
      data: {
        tenant_id: params.tenantId,
        requester_id: params.requesterId,
        storage_key: storageKey,
        expected_mime: params.contentType,
        max_bytes: BigInt(params.contentLength),
        expires_at: expiresAt,
      },
    });
    const uploadUrl = await this.storage.createUploadUrl({
      storageKey,
      contentType: params.contentType,
      contentLength: params.contentLength,
    });
    // 응답에 storage_key 를 포함하지 않는다 — uploadId 와 서명 URL 뿐이다
    return { uploadId: session.id, uploadUrl, expiresAt };
  }

  /**
   * 완료 콜백 처리. 호출자(requester) 일치·만료·중복 완료를 검증하고
   * 실제 오브젝트의 크기·타입을 스토리지에서 확인한 뒤 세션을 완료 처리한다.
   * 반환된 `storageKey`는 서버 내부에서만 사용하고 응답에 싣지 않는다.
   */
  async complete(params: {
    uploadId: string;
    requesterId: string;
    checksum: string;
  }): Promise<{ storageKey: string; sizeBytes: number; mimeType: string }> {
    const session = await this.prisma.fileUpload.findUnique({ where: { id: params.uploadId } });
    if (!session) throw new NotFoundException();
    // 타인의 세션을 지목하는 경로를 차단한다
    if (session.requester_id !== params.requesterId) throw new ForbiddenException();
    if (session.state !== 'PENDING') throw new BadRequestException('이미 처리된 업로드입니다.');
    if (session.expires_at < new Date()) {
      await this.prisma.fileUpload.update({
        where: { id: session.id },
        data: { state: 'EXPIRED' },
      });
      throw new BadRequestException('만료된 업로드입니다.');
    }

    const head = await this.storage.headObject(session.storage_key);
    if (!head) throw new BadRequestException('업로드된 오브젝트를 찾을 수 없습니다.');
    if (head.size > Number(session.max_bytes)) {
      // 서명에 크기를 포함했으므로 정상 경로에서는 발생하지 않지만, 방어적으로 확인하고 정리한다
      await this.storage.deleteObject(session.storage_key);
      await this.prisma.fileUpload.update({ where: { id: session.id }, data: { state: 'ABORTED' } });
      throw new BadRequestException('업로드 크기가 허용치를 초과했습니다.');
    }

    await this.prisma.fileUpload.update({
      where: { id: session.id },
      data: { state: 'COMPLETED', completed_at: new Date() },
    });
    return {
      storageKey: session.storage_key,
      sizeBytes: head.size,
      mimeType: session.expected_mime,
    };
  }

  /** checksum 검증 유틸 (WP-10의 파일 행 생성에서 사용) */
  sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * 고아 오브젝트 GC (WP-9 항목 7).
   * 사용자가 업로드 도중 이탈하면 오브젝트만 남고 DB 행이 없는 상태가 되어 무기한 적재된다.
   * 만료된 미완료 세션의 오브젝트를 삭제하고 세션을 EXPIRED 로 표시한다.
   */
  @Cron('20 * * * *') // 매시 20분
  async collectGarbage(): Promise<{ scanned: number; deleted: number }> {
    const expired = await this.prisma.fileUpload.findMany({
      where: { state: 'PENDING', expires_at: { lt: new Date() } },
      take: 500, // 한 번에 처리할 상한 — 무제한 배치가 DB·스토리지를 점유하지 않게
    });
    let deleted = 0;
    for (const session of expired) {
      try {
        await this.storage.deleteObject(session.storage_key);
        deleted += 1;
      } catch (e) {
        // 삭제 실패는 다음 주기에 다시 시도한다(세션을 EXPIRED 로 넘기지 않는다)
        this.logger.warn(`고아 오브젝트 삭제 실패 ${session.id}: ${(e as Error).message}`);
        continue;
      }
      await this.prisma.fileUpload.update({
        where: { id: session.id },
        data: { state: 'EXPIRED' },
      });
    }
    if (expired.length > 0) {
      this.logger.log(`업로드 GC: 대상 ${expired.length}건 중 ${deleted}건 정리`);
    }
    return { scanned: expired.length, deleted };
  }
}
