import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 도메인 API 입력 DTO (기획서 §10.2 입력 방향 화이트리스트).
 *
 * **`status`·`verify_token`·`verified_at`·`owner_id` 는 어떤 DTO 에도 두지 않는다.**
 * 그중 하나라도 입력으로 들어올 수 있으면 DNS 를 전혀 건드리지 않고 `VERIFIED` 를 자칭할 수
 * 있게 되어 DOM-3 검증 전체가 무의미해진다. 상태 전이는 검증 잡과 전용 엔드포인트로만 한다.
 */
export class CreateDomainDto {
  /** 정규화 전 원문. 서버가 `normalizeFqdn()` 으로 정규형을 만들어 저장한다 */
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  fqdn!: string;
}

/**
 * DOM-4 도메인 수정.
 *
 * 현재 도메인 행에서 사용자가 의미 있게 바꿀 수 있는 값은 FQDN 뿐이다. 그리고 FQDN 을 바꾸면
 * **검증 결과는 반드시 무효가 된다** — 그렇지 않으면 아무 도메인이나 검증한 뒤 이름만 갈아끼워
 * 임의 도메인의 소유권을 자칭할 수 있다. 서비스가 상태를 UNVERIFIED 로 되돌리고 토큰을 재발급한다.
 */
export class UpdateDomainDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(253)
  fqdn!: string;
}
