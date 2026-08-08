import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS, ROLES } from '../../../../db/seeds/permissions';

export interface ChangelogEntry {
  version: string;
  date: string | null;
  /** 'Added' | 'Fixed' | 'Changed' 등 구분별 항목 */
  sections: Array<{ kind: string; items: string[] }>;
}

export interface ComponentState {
  label: string;
  /** ok = 정상, mismatch = 정의와 실제가 다름, unknown = 확인 불가 */
  status: 'ok' | 'mismatch' | 'unknown';
  detail: string;
}

export interface VersionView {
  version: string;
  commit: string | null;
  startedAt: string;
  /** 정의와 실제 상태의 대조 — 하나라도 어긋나면 배포가 반쪽인 것이다 */
  components: ComponentState[];
  changelog: ChangelogEntry[];
}

const ROOT = path.resolve(__dirname, '../../../..');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const MIGRATIONS_DIR = path.join(ROOT, 'db/migrations');
const STARTED_AT = new Date();

/**
 * 버전·시스템 상태 (관리자 콘솔).
 *
 * "지금 이 서버가 무엇을 돌리고 있는가"에 한 화면으로 답한다. 버전 문자열만 보여주는 것으로는
 * 부족하다 — **코드는 새것인데 마이그레이션이나 시드가 안 붙은 상태**가 실제로 사고를 만들고,
 * 그때 증상은 "왜 이 권한이 없지?" 같은 엉뚱한 형태로 나타난다. 그래서 정의와 실제를 대조해
 * 함께 보여준다.
 *
 * 버전 문자열은 **git 명령을 실행해 얻지 않는다.** 컨테이너에는 .git 이 없는 것이 보통이고,
 * 있더라도 런타임에 셸을 띄우는 것은 그 자체로 공격면이다. 빌드 시 주입한 환경 변수를 쓰고,
 * 없으면 CHANGELOG 의 최신 릴리스로 대신한다.
 */
@Injectable()
export class VersionService {
  private readonly logger = new Logger(VersionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async overview(): Promise<VersionView> {
    const changelog = this.readChangelog();
    const released = changelog.find((e) => e.version.toLowerCase() !== 'unreleased');

    return {
      version: process.env.APP_VERSION ?? released?.version ?? 'unknown',
      commit: process.env.GIT_COMMIT ?? null,
      startedAt: STARTED_AT.toISOString(),
      components: [await this.migrationState(), await this.seedState()],
      changelog,
    };
  }

  /**
   * 마이그레이션 적용 상태.
   * **디스크의 파일 수와 DB 적용 수를 대조한다** — 적용만 세면 "덜 적용된 상태"를 정상으로 읽는다.
   */
  private async migrationState(): Promise<ComponentState> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ n: bigint; latest: string | null }>>`
        SELECT count(*) AS n, max(migration_name) AS latest
          FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      const applied = Number(rows[0]?.n ?? 0);

      let onDisk = 0;
      if (fs.existsSync(MIGRATIONS_DIR)) {
        onDisk = fs
          .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
          .filter((e) => e.isDirectory()).length;
      }
      if (onDisk === 0) {
        // 배포 이미지에 마이그레이션 폴더를 넣지 않는 구성도 있다 — 그때는 대조 불가다
        return {
          label: 'DB 마이그레이션',
          status: 'unknown',
          detail: `${applied}개 적용 (파일 목록을 찾을 수 없어 대조 불가)`,
        };
      }
      return {
        label: 'DB 마이그레이션',
        status: applied === onDisk ? 'ok' : 'mismatch',
        detail: `${applied}/${onDisk} 적용 · 최신 ${rows[0]?.latest ?? '없음'}`,
      };
    } catch (error) {
      this.logger.warn(`마이그레이션 상태 확인 실패: ${(error as Error).message}`);
      return { label: 'DB 마이그레이션', status: 'unknown', detail: '확인 실패' };
    }
  }

  /**
   * 권한 시드 정합.
   * 시드 정의(`db/seeds/permissions.ts`)와 DB 실제 행 수를 대조한다. 어긋나면 시드가 안 돌았거나
   * 누군가 직접 손댄 것이며, 둘 다 권한 판정이 설계와 달라진다는 뜻이다.
   */
  private async seedState(): Promise<ComponentState> {
    try {
      const [perms, roles] = await Promise.all([
        this.prisma.permission.count(),
        this.prisma.role.count({ where: { is_system: true } }),
      ]);
      const expectedPerms = PERMISSIONS.length;
      const expectedSystemRoles = ROLES.filter((r) => r.isSystem).length;
      const ok = perms === expectedPerms && roles >= expectedSystemRoles;
      return {
        label: '권한 시드',
        status: ok ? 'ok' : 'mismatch',
        detail: `Permission ${perms}/${expectedPerms} · 시스템 역할 ${roles} (정의 ${expectedSystemRoles} 이상)`,
      };
    } catch (error) {
      this.logger.warn(`시드 상태 확인 실패: ${(error as Error).message}`);
      return { label: '권한 시드', status: 'unknown', detail: '확인 실패' };
    }
  }

  /**
   * CHANGELOG 파싱. **화면에 이력을 박아 두지 않기 위한 것**이다 —
   * 같은 사실이 파일과 화면 두 곳에 있으면 언젠가 갈라진다(§15.1).
   */
  private readChangelog(limit = 10): ChangelogEntry[] {
    if (!fs.existsSync(CHANGELOG_PATH)) return [];
    const lines = fs.readFileSync(CHANGELOG_PATH, 'utf8').split('\n');

    const entries: ChangelogEntry[] = [];
    let current: ChangelogEntry | null = null;
    let section: { kind: string; items: string[] } | null = null;

    for (const line of lines) {
      const release = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line);
      if (release) {
        current = { version: release[1], date: release[2] ?? null, sections: [] };
        section = null;
        entries.push(current);
        continue;
      }
      if (!current) continue;

      const kind = /^###\s+(.+)/.exec(line);
      if (kind) {
        section = { kind: kind[1].trim(), items: [] };
        current.sections.push(section);
        continue;
      }
      const item = /^[-*]\s+(.+)/.exec(line);
      if (item && section) section.items.push(item[1].trim());
    }
    // 항목이 하나도 없는 섹션은 내보내지 않는다 (빈 Unreleased 가 화면을 어지럽힌다)
    return entries
      .map((e) => ({ ...e, sections: e.sections.filter((s) => s.items.length > 0) }))
      .filter((e) => e.sections.length > 0)
      .slice(0, limit);
  }
}
