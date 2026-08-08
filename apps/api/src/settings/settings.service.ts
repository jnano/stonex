import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@stonex/db';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_TENANT_ID } from '../../../../db/seeds/permissions';
import { open, seal } from './secret-box';
import { SETTING_CATEGORIES, SettingCategory, findCategory, findField } from './settings.definition';

/** 화면에 내려보내는 형태 — **비밀값은 절대 포함되지 않는다** */
export interface CategoryView {
  category: string;
  label: string;
  description: string;
  testable: boolean;
  fields: Array<{
    key: string;
    label: string;
    kind: string;
    hint?: string;
    required?: boolean;
    options?: Array<{ value: string; label: string }>;
    placeholder?: string;
    /** 평문 항목의 현재 값. 비밀 항목은 항상 null */
    value: string | null;
    /** 비밀 항목이 설정돼 있는가 — 값 대신 이것만 알려준다 */
    configured: boolean;
  }>;
}

/**
 * 시스템 설정 (범용 배포 지원).
 *
 * **설정의 출처는 DB 한 곳이다.** 환경 변수 폴백을 두지 않는 이유는, 두 곳에서 읽으면
 * "화면에는 A 인데 실제로는 B 로 동작하는" 상태가 생기고 그걸 추적하기가 매우 어렵기 때문이다.
 * 개발·CI 환경은 `scripts/seed-settings.ts` 로 DB 에 넣어 준다(런타임 폴백이 아니라 프로비저닝).
 *
 * 값이 바뀌면 `version` 이 올라간다. 메일러·스토리지가 이 값을 보고 접속 객체를 다시 만든다 —
 * 설정을 바꾸려고 서버를 재기동해야 한다면 화면으로 옮긴 의미가 절반은 사라진다.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache = new Map<string, Record<string, string>>();
  private version = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 설정 변경 세대 번호 — 소비자(메일러·스토리지)가 캐시 무효화에 쓴다 */
  get generation(): number {
    return this.version;
  }

  /** 서버 내부용 — 복호화된 실제 값 */
  async values(category: string, tenantId = DEFAULT_TENANT_ID): Promise<Record<string, string>> {
    const cacheKey = `${tenantId}:${category}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const rows = await this.prisma.systemSetting.findMany({ where: { tenant_id: tenantId, category } });
    const out: Record<string, string> = {};
    for (const row of rows) {
      if (row.is_secret) {
        if (!row.secret_value) continue;
        try {
          out[row.key] = open(row.secret_value);
        } catch (error) {
          // 복호화 실패를 조용히 넘기면 "설정했는데 왜 안 되지"가 된다
          this.logger.error(`설정 복호화 실패 (${category}.${row.key}): ${(error as Error).message}`);
        }
      } else if (row.value !== null) {
        out[row.key] = row.value;
      }
    }
    this.cache.set(cacheKey, out);
    return out;
  }

  /** 화면용 — 비밀값은 빼고 "설정됨" 여부만 */
  async view(tenantId = DEFAULT_TENANT_ID): Promise<CategoryView[]> {
    const rows = await this.prisma.systemSetting.findMany({ where: { tenant_id: tenantId } });
    const byKey = new Map(rows.map((r) => [`${r.category}.${r.key}`, r]));

    return SETTING_CATEGORIES.map((cat: SettingCategory) => ({
      category: cat.category,
      label: cat.label,
      description: cat.description,
      testable: cat.testable,
      fields: cat.fields.map((f) => {
        const row = byKey.get(`${cat.category}.${f.key}`);
        return {
          key: f.key,
          label: f.label,
          kind: f.kind,
          hint: f.hint,
          required: f.required,
          options: f.options,
          placeholder: f.placeholder,
          // 비밀값은 어떤 경로로도 내보내지 않는다(§10.2)
          value: f.kind === 'secret' ? null : (row?.value ?? null),
          configured: f.kind === 'secret' ? Boolean(row?.secret_value) : row?.value !== undefined,
        };
      }),
    }));
  }

  /**
   * 저장. **빈 문자열로 온 비밀 항목은 "변경 없음"으로 본다** —
   * 화면이 현재 값을 모르므로(내려주지 않으므로) 빈 칸을 저장으로 처리하면
   * 다른 항목 하나 고칠 때마다 비밀번호가 지워진다.
   */
  async update(
    category: string,
    input: Record<string, string>,
    actor: { id: string; tenantId: string },
  ): Promise<CategoryView[]> {
    const def = findCategory(category);
    if (!def) throw new NotFoundException();

    const changed: string[] = [];
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const [key, raw] of Object.entries(input)) {
        const field = findField(category, key);
        if (!field) throw new BadRequestException(`알 수 없는 설정 항목입니다: ${key}`);

        const value = typeof raw === 'string' ? raw.trim() : '';
        if (field.kind === 'secret' && value === '') continue; // 변경 없음
        if (field.required && value === '') {
          throw new BadRequestException(`${field.label} 은(는) 필수입니다.`);
        }
        if (field.kind === 'number' && value !== '' && !/^\d+$/.test(value)) {
          throw new BadRequestException(`${field.label} 은(는) 숫자여야 합니다.`);
        }
        if (field.kind === 'select' && value !== '' && !field.options?.some((o) => o.value === value)) {
          throw new BadRequestException(`${field.label} 값이 올바르지 않습니다.`);
        }

        const isSecret = field.kind === 'secret';
        await tx.systemSetting.upsert({
          where: {
            tenant_id_category_key: { tenant_id: actor.tenantId, category, key },
          },
          update: {
            value: isSecret ? null : value,
            secret_value: isSecret ? seal(value) : null,
            is_secret: isSecret,
            updated_by: actor.id,
          },
          create: {
            tenant_id: actor.tenantId,
            category,
            key,
            value: isSecret ? null : value,
            secret_value: isSecret ? seal(value) : null,
            is_secret: isSecret,
            updated_by: actor.id,
          },
        });
        changed.push(key);
      }

      // **바뀐 항목 이름만 남기고 값은 남기지 않는다.** 평문 항목이라도 엔드포인트·사용자명은
      // 조합하면 접속 정보가 되며, 감사 로그는 보존이 길고 조회 권한이 넓다.
      await this.audit.record(tx, {
        tenantId: actor.tenantId,
        actorId: actor.id,
        action: 'system.settings.update',
        targetType: 'settings',
        detail: { before: {}, after: { category, changedKeys: changed } },
      });
    });

    this.invalidate();
    return this.view(actor.tenantId);
  }

  /** 캐시 비우기 + 세대 증가 — 소비자가 접속 객체를 다시 만들게 한다 */
  invalidate(): void {
    this.cache.clear();
    this.version += 1;
  }
}
