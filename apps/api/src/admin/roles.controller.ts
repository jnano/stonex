import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UnauthorizedException } from '@nestjs/common';
import { RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { RoleDetail, RoleSummary, RolesService } from './roles.service';

/** 관리자 콘솔 — 역할·매핑 (기획서 §6.5 ADM-1~3, §7.2) */
@Controller('admin/roles')
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermission('admin.role.read')
  @Get()
  async list(@Req() req: AuthedRequest): Promise<RoleSummary[]> {
    return this.roles.list(subjectOf(req).tenantId);
  }

  /** 매핑 편집 UI 가 쓰는 Permission 카탈로그 (assignable 여부 포함) */
  @RequirePermission('admin.role.read')
  @Get('permissions')
  async permissions(@Req() req: AuthedRequest) {
    return this.roles.assignablePermissions(subjectOf(req));
  }

  @RequirePermission('admin.role.read')
  @Get(':id')
  async detail(@Param('id') id: string): Promise<RoleDetail> {
    return this.roles.detail(id);
  }

  @RequirePermission('admin.role.manage')
  @Post()
  async create(
    @Req() req: AuthedRequest,
    @Body() body: { code: string; name: string; displayOrder?: number; requires2fa?: boolean },
  ): Promise<RoleDetail> {
    return this.roles.create(subjectOf(req), body);
  }

  @RequirePermission('admin.role.manage')
  @Post(':id/duplicate')
  async duplicate(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { code: string; name: string },
  ): Promise<RoleDetail> {
    return this.roles.duplicate(subjectOf(req), id, body.code, body.name);
  }

  @RequirePermission('admin.role.manage')
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { name?: string; displayOrder?: number; requires2fa?: boolean },
  ): Promise<RoleDetail> {
    return this.roles.update(subjectOf(req), id, body);
  }

  @RequirePermission('admin.role.manage')
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.roles.remove(subjectOf(req), id);
    return { ok: true };
  }

  /** 전체 치환 방식 (§7.2) — 보유하지 않은 Permission 부여는 거부된다(§10.1) */
  @RequirePermission('admin.role.manage')
  @Put(':id/permissions')
  async setPermissions(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { codes: string[] },
  ): Promise<RoleDetail> {
    return this.roles.setPermissions(subjectOf(req), id, body.codes ?? []);
  }
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}
