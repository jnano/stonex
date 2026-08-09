import { HealthController } from './health.controller';
import { AuthController } from './auth/auth.controller';
import { devLoginControllers } from './auth/dev-login';
import { MeController } from './me/me.controller';
import { MembersController } from './members/members.controller';
import { AdminRolesController } from './admin/roles.controller';
import { AdminFilesController, FilesController } from './files/files.controller';
import {
  AdminDomainsController,
  DomainTransfersController,
  DomainsController,
} from './domains/domains.controller';
import { GovernanceController } from './governance/governance.controller';
import { AdminAuditController } from './admin/audit.controller';
import { SettingsController } from './settings/settings.controller';
import {
  BoardAdminController,
  BoardsController,
  CommentsController,
  NotificationsController,
  PostsController,
  UserBlocksController,
} from './board/board.controllers';

/**
 * 전체 컨트롤러 목록 — AppModule 과 G-5 검사(bootstrap-check)가 공유하는 유일한 출처.
 * 새 컨트롤러는 반드시 이 배열에 등록한다 (AppModule 에 직접 추가 금지 —
 * 여기서 빠지면 G-5 미선언 검사의 사각지대가 된다).
 */
export const CONTROLLERS = [
  HealthController,
  AuthController,
  MeController,
  MembersController,
  AdminRolesController,
  FilesController,
  AdminFilesController,
  DomainsController,
  AdminDomainsController,
  DomainTransfersController,
  GovernanceController,
  AdminAuditController,
  SettingsController,
  // ── board 모듈 기여 (D-2) ──
  BoardsController,
  PostsController,
  CommentsController,
  NotificationsController,
  UserBlocksController,
  BoardAdminController,
  // 개발 전용 로그인 — DEV_LOGIN=1 + 비프로덕션일 때만 배열에 들어간다.
  // 조건 미충족이면 **라우트 자체가 없다**(404, 인가 판정 이전). 배포 차단의 1차 방어다.
  ...devLoginControllers(),
];
