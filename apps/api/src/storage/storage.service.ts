import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,

} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** 기획서 §6.3 FILE-2: 다운로드 서명 URL 만료 60초 */
export const DOWNLOAD_URL_TTL_SECONDS = 60;
/** 업로드 서명 URL 만료 5분 (작업지시서 WP-9) */
export const UPLOAD_URL_TTL_SECONDS = 300;
/** 업로드 크기 상한 기본값 100MB (기획서 §10.4) */
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/**
 * S3 호환 오브젝트 스토리지 어댑터 (기획서 §3).
 *
 * 접속 정보는 환경 변수로만 주입한다(하드코딩 금지). 개발·CI는 MinIO, 운영은 AWS S3.
 *
 * **서명 URL의 성질을 분명히 해 둔다**: 발급된 URL은 요청자 신원이 담기지 않은 무기명
 * 자격증명이다. 따라서 권한 회수 후에도 **이미 발급된 URL은 만료까지 유효**하며, URL을
 * 전달받은 제3자도 사용할 수 있다 — 애플리케이션 계층의 재공유 금지(§10.1)가 전송 계층에서는
 * 성립하지 않는다. 이는 기획서 §14.5-4에 기재된 수용 리스크이며, 그래서 만료를 짧게(60초) 둔다.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private cached: { client: S3Client; bucket: string } | null = null;
  private builtFor = -1;

  constructor(private readonly settings: SettingsService) {}

  /**
   * 접속 객체를 설정에서 만든다. **설정이 바뀌면 다시 만든다** — 관리 화면에서 엔드포인트를
   * 고쳤는데 재기동 전까지 옛 저장소에 쓰고 있으면, 그 사이 올라간 파일을 잃는다.
   */
  private async resolve(): Promise<{ client: S3Client; bucket: string }> {
    if (this.cached && this.builtFor === this.settings.generation) return this.cached;

    const config = await this.settings.values('storage');
    if (!config.bucket) {
      throw new Error('저장소 설정이 완료되지 않았습니다 (관리 › 시스템 설정에서 입력하십시오).');
    }
    const client = new S3Client({
      region: config.region || 'us-east-1',
      // 엔드포인트가 있으면 S3 호환(MinIO·NCP 등) — path-style 이 필요하다
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: config.accessKey ?? '',
        secretAccessKey: config.secretKey ?? '',
      },
    });
    this.cached = { client, bucket: config.bucket };
    this.builtFor = this.settings.generation;
    return this.cached;
  }

  /** 추측 불가능한 오브젝트 키. 외부에 노출하지 않는다(§10.2) */
  createStorageKey(tenantId: string): string {
    return `${tenantId}/${randomUUID()}`;
  }

  /**
   * 업로드용 서명 URL. Content-Type 과 Content-Length 를 **서명에 포함**해,
   * 발급 조건과 다른 요청은 스토리지가 거부하게 한다(서버 검증이 콜백에만 의존하지 않도록).
   */
  async createUploadUrl(params: {
    storageKey: string;
    contentType: string;
    contentLength: number;
  }): Promise<string> {
    const { client, bucket } = await this.resolve();
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: params.storageKey,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
    });
    return getSignedUrl(client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
  }

  /** 다운로드용 서명 URL. 브라우저 인라인 실행을 막기 위해 attachment 를 강제한다(§10.4) */
  async createDownloadUrl(params: { storageKey: string; fileName: string }): Promise<string> {
    const { client, bucket } = await this.resolve();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: params.storageKey,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(params.fileName)}"`,
    });
    return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  }

  /**
   * 브라우저에 **그대로 띄우는** URL (inline) — 게시판 본문의 이미지처럼 다운로드가
   * 아니라 표시가 목적일 때. 다운로드 URL 과 달리 Content-Disposition 을 attachment 로
   * 강제하지 않는다. 서명 URL 이므로 만료가 있고 storage_key 는 노출되지 않는다.
   */
  async createInlineUrl(params: { storageKey: string; contentType: string }): Promise<string> {
    const { client, bucket } = await this.resolve();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: params.storageKey,
      ResponseContentDisposition: 'inline',
      ResponseContentType: params.contentType,
    });
    return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  }

  /** 업로드 완료 검증용 — 실제 오브젝트의 크기·타입·체크섬 확인 */
  async headObject(storageKey: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const { client, bucket } = await this.resolve();
      const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
      return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
    } catch {
      return null; // 오브젝트 부재
    }
  }

  /** 오브젝트 전체를 버퍼로 — 서버측 후처리(이미지 재인코딩 등) 전용. 응답 경로 사용 금지 */
  async getObjectBuffer(storageKey: string): Promise<Buffer> {
    const { client, bucket } = await this.resolve();
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  /** 후처리 결과를 같은 키에 재기록 — 원본 교체(EXIF 제거 등)에 쓴다 */
  async putObjectBuffer(storageKey: string, body: Buffer, contentType: string): Promise<void> {
    const { client, bucket } = await this.resolve();
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: storageKey, Body: body, ContentType: contentType }));
  }

  async deleteObject(storageKey: string): Promise<void> {
    const { client, bucket } = await this.resolve();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }));
  }

  /** readiness 점검용 (§WP-9 항목 8) */
  async ping(): Promise<boolean> {
    try {
      const { client, bucket } = await this.resolve();
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (e) {
      this.logger.warn(`스토리지 접속 실패: ${(e as Error).message}`);
      return false;
    }
  }
}
