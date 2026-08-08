import { Body, Controller, Get, Inject, Param, Post, Put, Req, UnauthorizedException } from '@nestjs/common';
import { IsObject } from 'class-validator';
import { RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { StorageService } from '../storage/storage.service';
import { MAILER, Mailer, ConfiguredMailer } from '../auth/mailer';
import { CategoryView, SettingsService } from './settings.service';
import { isKeyConfigured } from './secret-box';

export class UpdateSettingsDto {
  @IsObject()
  values!: Record<string, string>;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

/**
 * 시스템 설정 (범용 배포 지원).
 *
 * 게이트는 `system.settings.manage`(SUPER_ADMIN 전용) — 접속 자격 증명을 다루는 화면이라
 * 조회조차 좁게 연다. 시드에 이 권한이 있었지만 쓰는 곳이 없었고, 여기가 첫 사용처다.
 *
 * **비밀값은 어떤 응답에도 실리지 않는다.** 화면은 "설정됨" 여부만 받고, 바꿀 때만 새 값을 보낸다.
 */
@Controller('admin/settings')
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  @RequirePermission('system.settings.manage')
  @Get()
  async list(@Req() req: AuthedRequest): Promise<{
    categories: CategoryView[];
    encryptionKeyConfigured: boolean;
  }> {
    return {
      categories: await this.settings.view(subjectOf(req).tenantId),
      // 열쇠가 없으면 비밀값을 저장할 수 없다. 저장 시점에 실패하기 전에 화면이 먼저 알려준다.
      encryptionKeyConfigured: isKeyConfigured(),
    };
  }

  @RequirePermission('system.settings.manage')
  @Put(':category')
  async update(
    @Req() req: AuthedRequest,
    @Param('category') category: string,
    @Body() body: UpdateSettingsDto,
  ): Promise<CategoryView[]> {
    const subject = subjectOf(req);
    return this.settings.update(category, body.values, { id: subject.id, tenantId: subject.tenantId });
  }

  /**
   * 연결 테스트. **저장한 설정이 실제로 통하는지 지금 확인한다** —
   * 없으면 잘못된 설정이 조용히 저장되고, 실패는 회원가입 시점에야 드러난다.
   */
  @RequirePermission('system.settings.manage')
  @Post(':category/test')
  async test(@Param('category') category: string): Promise<TestResult> {
    try {
      if (category === 'mail') {
        if (!(this.mailer instanceof ConfiguredMailer)) {
          return { ok: false, message: '현재 메일러가 설정 기반이 아닙니다.' };
        }
        await this.mailer.verify();
        return { ok: true, message: 'SMTP 인증에 성공했습니다.' };
      }
      if (category === 'storage') {
        const ok = await this.storage.ping();
        return ok
          ? { ok: true, message: '버킷에 접근할 수 있습니다.' }
          : { ok: false, message: '버킷에 접근하지 못했습니다. 엔드포인트·키·버킷명을 확인하십시오.' };
      }
      return { ok: false, message: '연결 테스트를 지원하지 않는 항목입니다.' };
    } catch (error) {
      // 실패 사유는 그대로 보여준다 — 이 화면을 보는 사람은 SUPER_ADMIN 이고,
      // 원인을 감추면 설정을 고칠 방법이 없다
      return { ok: false, message: (error as Error).message };
    }
  }
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}
