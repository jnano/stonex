import { Injectable } from '@nestjs/common';

/**
 * 소유자 정리 훅 레지스트리 (Phase 3 WP-K2, 계획서 MC-7).
 *
 * 회원이 삭제되면 그 회원이 소유한 리소스도 처리해야 한다(WT-17). 기존에는
 * members.service 가 FilesService 를 직접 주입해 파일만 정리했고 — 커널이 소유 자원을
 * **열거하려 든** 구조라, 도메인은 정리 연쇄에서 빠져 있었다(알려진 결함).
 *
 * 이제 커널은 "등록된 훅을 전부 부른다"만 알고, 무엇이 등록됐는지 모른다.
 * 각 리소스 타입이 자기 정리를 서술하며, 신규 타입은 훅 등록만으로 정리 연쇄에 편입된다.
 *
 * 실행 모델 (RT-27 + DEC-3 "즉시 차단"):
 *  - 삭제 트랜잭션 안(in-tx)은 O(1) — `owner_cleanup_jobs` 행 1건. 보유량에 비례하는
 *    쓰기를 트랜잭션에 넣으면 SuperAdminGuard 의 FOR UPDATE 와 경합한다(WT-17).
 *  - 은닉은 표식(users.deleted_at)이 **즉시** 담당한다 — 로더·목록이 소유자 삭제를 보고
 *    커밋 직후부터 404/제외 처리하므로 가시성 창이 없다(DEC-3).
 *  - 실제 소프트삭제·Grant 정리는 워커가 이 훅의 purge 를 배치 상한으로 반복 호출한다.
 */

export interface PurgeContext {
  tenantId: string;
  /** 삭제를 지시한 관리자 — 잡 생성 시점에 기록되지 않으므로 감사에는 시스템 주체로 남는다 */
  actorId: string | null;
}

export interface PurgeResult {
  purged: number;
  /** true 면 상한에 걸려 남은 것이 있다 — 워커가 다음 틱에 같은 잡을 계속한다 */
  remaining: boolean;
}

export interface OwnerCleanupHook {
  /** 리소스 타입 (로그·감사 표기용) */
  type: string;
  /**
   * 삭제된 소유자의 리소스 1배치 정리 (소프트삭제 + Grant 정리).
   * 자체 트랜잭션으로 실행된다 — 회원 삭제 트랜잭션과 분리(RT-27).
   * 배치 하나가 실패해도 이미 커밋된 배치는 유지된다(멱등하게 재시도 가능해야 한다).
   */
  purgeOwnerDeleted(userId: string, context: PurgeContext, limit: number): Promise<PurgeResult>;
}

@Injectable()
export class OwnerCleanupRegistry {
  private readonly hooks: OwnerCleanupHook[] = [];

  register(hook: OwnerCleanupHook): void {
    if (this.hooks.some((h) => h.type === hook.type)) {
      throw new Error(`소유자 정리 훅이 중복 등록되었습니다: ${hook.type}`);
    }
    this.hooks.push(hook);
  }

  all(): OwnerCleanupHook[] {
    return [...this.hooks];
  }
}
