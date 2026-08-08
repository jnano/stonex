import { HealthController } from './health.controller';
import { AuthController } from './auth/auth.controller';
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
];
