import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthenticatedOnly, Public, RequireDominance, RequirePermission } from '../authorization/decorators';
import { AuthedRequest } from '../authorization/guards/auth.guard';
import { SubjectSnapshot } from '../authorization/types';
import { MembersService } from './members.service';
import { EmailChangeService, EmailChangeView } from './email-change.service';
import { MemberDetail, MemberSummary } from './member.serializer';

/** 이메일 변경 요청 — 재인증 요소를 함께 받는다(§6.2 MEM-1) */
export class RequestEmailChangeDto {
  @IsEmail()
  @MaxLength(255)
  newEmail!: string;

  /** 현재 TOTP 코드 */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;

  /** 또는 현재 비밀번호 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;
}

export class ConfirmEmailChangeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token!: string;
}

/** 이메일 변경 요청도 인증 API 와 같은 속도 제한을 받는다 — step-up 대입 시도를 막는다 */
const EMAIL_CHANGE_RATE = { limit: Number(process.env.AUTH_RATE_LIMIT ?? 5), ttl: 60_000 };

/**
 * 회원 관리 API (기획서 §6.2, §7.2).
 *
 * 관리 행위(MEM-3~6)는 @RequirePermission 에 더해 @RequireDominance 로 우위 검사를 선언한다.
 * Guard 통과 후 서비스 계층이 부분집합 검사·불변식·감사까지 담당한다(이중 방어).
 */
@Controller('members')
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly emailChange: EmailChangeService,
  ) {}

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

  // ── MEM-1 이메일(로그인 식별자) 변경 — 재인증 + 새 주소 소유 확인 ──
  /**
   * 요청. 원문 토큰은 응답에 싣지 않고 **새 주소로만** 보낸다 —
   * 응답에 실으면 그 주소를 소유하지 않아도 확인을 마칠 수 있어 2단계가 무의미해진다.
   */
  @AuthenticatedOnly()
  @Throttle({ default: EMAIL_CHANGE_RATE })
  @Post('me/email-change')
  async requestEmailChange(
    @Req() req: AuthedRequest,
    @Body() body: RequestEmailChangeDto,
  ): Promise<EmailChangeView> {
    return this.emailChange.request(subjectOf(req), {
      newEmail: body.newEmail,
      stepUp: { code: body.code, password: body.password },
    });
  }

  @AuthenticatedOnly()
  @Get('me/email-change')
  async pendingEmailChange(@Req() req: AuthedRequest): Promise<EmailChangeView | null> {
    return this.emailChange.pending(subjectOf(req));
  }

  @AuthenticatedOnly()
  @Delete('me/email-change/:id')
  async cancelEmailChange(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.emailChange.cancel(subjectOf(req), id);
    return { ok: true };
  }

  /**
   * 확인 — **@Public 이다.** 새 주소로 받은 링크를 누르는 시점에는 로그인 상태가 아닐 수 있고,
   * 토큰 자체가 소유 증명이다. 토큰은 1회용이며 해시만 저장된다.
   */
  @Public()
  @Throttle({ default: EMAIL_CHANGE_RATE })
  @Post('email-change/confirm')
  async confirmEmailChange(@Body() body: ConfirmEmailChangeDto): Promise<{ ok: true }> {
    await this.emailChange.confirm(body.token);
    return { ok: true };
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
