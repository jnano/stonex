import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { AuthenticatedOnly, RequireDominance, RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { MembersService } from './members.service';
import { MemberDetail, MemberSummary } from './member.serializer';

/**
 * 회원 관리 API (기획서 §6.2, §7.2).
 *
 * 관리 행위(MEM-3~6)는 @RequirePermission 에 더해 @RequireDominance 로 우위 검사를 선언한다.
 * Guard 통과 후 서비스 계층이 부분집합 검사·불변식·감사까지 담당한다(이중 방어).
 */
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  // ── MEM-1 내 프로필 (본인 한정 — Permission 검사 대상 아님) ──
  @AuthenticatedOnly()
  @Get('me')
  async myProfile(@Req() req: AuthedRequest): Promise<MemberDetail> {
    return this.members.myProfile(subjectOf(req).id);
  }

  @AuthenticatedOnly()
  @Patch('me')
  async updateMyProfile(
    @Req() req: AuthedRequest,
    @Body() body: { name?: string },
  ): Promise<MemberDetail> {
    return this.members.updateMyProfile(subjectOf(req).id, body);
  }

  // ── MEM-2 목록·상세 ──
  @RequirePermission('member.read')
  @Get()
  async list(
    @Query('page') page?: string,
    @Query('size') size?: string,
  ): Promise<{ items: MemberSummary[]; total: number }> {
    return this.members.list(Number(page ?? 1), Number(size ?? 20));
  }

  @RequirePermission('member.read')
  @Get(':id')
  async detail(@Param('id') id: string): Promise<MemberDetail> {
    return this.members.detail(id);
  }

  /** 관리 가능/불가 + 사유 (§4.6-3) — 콘솔이 버튼 상태와 안내 문구를 만드는 데 쓴다 */
  @RequirePermission('member.read')
  @Get(':id/manageable')
  async manageable(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.members.dominanceCheck(subjectOf(req), id);
  }

  // ── MEM-3~6 관리 행위 ──
  @RequirePermission('member.update')
  @RequireDominance('id')
  @Patch(':id')
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { name?: string },
  ): Promise<MemberDetail> {
    return this.members.update(subjectOf(req), id, body);
  }

  @RequirePermission('member.ban')
  @RequireDominance('id')
  @Post(':id/ban')
  async ban(@Req() req: AuthedRequest, @Param('id') id: string): Promise<MemberDetail> {
    return this.members.setBanned(subjectOf(req), id, true);
  }

  @RequirePermission('member.ban')
  @RequireDominance('id')
  @Post(':id/unban')
  async unban(@Req() req: AuthedRequest, @Param('id') id: string): Promise<MemberDetail> {
    return this.members.setBanned(subjectOf(req), id, false);
  }

  @RequirePermission('member.role.assign')
  @RequireDominance('id')
  @Post(':id/roles')
  async grantRole(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { roleId: string; expiresAt?: string },
  ): Promise<MemberDetail> {
    return this.members.grantRole(
      subjectOf(req), id, body.roleId,
      body.expiresAt ? new Date(body.expiresAt) : null,
    );
  }

  @RequirePermission('member.role.assign')
  @RequireDominance('id')
  @Delete(':id/roles/:roleId')
  async revokeRole(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('roleId') roleId: string,
  ): Promise<MemberDetail> {
    return this.members.revokeRole(subjectOf(req), id, roleId);
  }

  @RequirePermission('member.delete')
  @RequireDominance('id')
  @Delete(':id')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    await this.members.softDelete(subjectOf(req), id);
    return { ok: true };
  }
}

function subjectOf(req: AuthedRequest): SubjectSnapshot {
  const subject = req.subject;
  if (!subject) throw new UnauthorizedException();
  return subject;
}
