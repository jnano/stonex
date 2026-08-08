import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * 파일 API 입력 DTO (기획서 §10.2 입력 방향 화이트리스트).
 *
 * 전역 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`가 여기 선언되지 않은
 * 필드를 거부한다. **`owner_id`·`status`·`tenant_id`·`storage_key`·`checksum` 은 어떤 DTO 에도
 * 두지 않는다** — 그 필드가 입력으로 들어올 수 있으면 공유 수령자가 소유권을 탈취할 수 있다(§10.1).
 * 소유권·상태 전이는 전용 엔드포인트로만 한다.
 */
export class CreateUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(127)
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  sizeBytes!: number;
}

export class CompleteUploadDto {
  @IsString()
  @IsNotEmpty()
  uploadId!: string;

  /** 업로더가 계산한 SHA-256. 서버가 오브젝트 크기와 함께 대조한다 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  checksum!: string;
}

/** 파일 메타데이터 수정 — 이름만 바꿀 수 있다 */
export class UpdateFileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;
}
