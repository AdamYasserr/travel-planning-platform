import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AdministrationService } from './administration.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AdminAccountQueryDto, AdminBookingQueryDto, AdminProviderType, CreateModeratorDto } from './dto/administration.dto';

type AdminRequest = Request & { user: { userId: string } };

@Controller('admin')
@Roles(UserRole.ADMIN)
@ApiTags('Administration')
@ApiCookieAuth('access_token')
export class AdministrationController {
  constructor(private readonly administrationService: AdministrationService) {}

  @Post('moderators')
  @ApiOperation({ summary: 'Create an airline or hotel moderator assigned to one provider' })
  @ApiBody({ type: CreateModeratorDto })
  createModerator(@Req() req: AdminRequest, @Body() dto: CreateModeratorDto) {
    return this.administrationService.createModerator(req.user.userId, dto);
  }

  @Get('accounts')
  @ApiOperation({ summary: 'List platform accounts with filtering and pagination' })
  listAccounts(@Query() query: AdminAccountQueryDto) { return this.administrationService.listAccounts(query); }

  @Get('accounts/:id')
  @ApiOperation({ summary: 'Inspect one platform account without credentials or session secrets' })
  getAccount(@Param('id') id: string) { return this.administrationService.getAccount(id); }

  @Patch('accounts/:id/suspend')
  @ApiOperation({ summary: 'Suspend a user or moderator account and revoke its sessions' })
  suspend(@Req() req: AdminRequest, @Param('id') id: string) { return this.administrationService.setAccountSuspended(req.user.userId, id, true); }

  @Patch('accounts/:id/reactivate')
  @ApiOperation({ summary: 'Reactivate a suspended user or moderator account' })
  reactivate(@Req() req: AdminRequest, @Param('id') id: string) { return this.administrationService.setAccountSuspended(req.user.userId, id, false); }

  @Patch('providers/:type/:id/deactivate')
  @ApiOperation({ summary: 'Deactivate an airline or hotel for new bookings' })
  deactivateProvider(@Req() req: AdminRequest, @Param('type') type: AdminProviderType, @Param('id') id: string) { return this.administrationService.setProviderActive(req.user.userId, type, id, false); }

  @Patch('providers/:type/:id/reactivate')
  @ApiOperation({ summary: 'Reactivate an airline or hotel' })
  reactivateProvider(@Req() req: AdminRequest, @Param('type') type: AdminProviderType, @Param('id') id: string) { return this.administrationService.setProviderActive(req.user.userId, type, id, true); }

  @Get('bookings')
  @ApiOperation({ summary: 'Inspect flight and hotel bookings platform-wide' })
  listBookings(@Query() query: AdminBookingQueryDto) { return this.administrationService.listBookings(query); }

  @Post('users/:id/reset-password')
  @ApiOperation({ summary: 'Reset a user or moderator password; force password change at next login' })
  @ApiParam({ name: 'id', description: 'Target user MongoDB ObjectId', example: '507f1f77bcf86cd799439011' })
  @ApiResponse({ status: 201, description: 'Password reset. The one-time temporary password is returned in the response only.' })
  resetUserPassword(@Req() req: AdminRequest, @Param('id') userId: string) {
    return this.administrationService.resetUserPassword(req.user.userId, userId);
  }
}
