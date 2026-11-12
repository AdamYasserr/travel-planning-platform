import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AdministrationService } from './administration.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { CreateModeratorDto } from './dto/create-moderator.dto';
import { QueryAccountsDto } from './dto/query-accounts.dto';

@Controller('admin')
@Roles(UserRole.ADMIN)
@ApiTags('Administration')
@ApiCookieAuth('access_token')
export class AdministrationController {
  constructor(
    private readonly administrationService: AdministrationService,
  ) {}

  @Post('users/:id/reset-password')
  @ApiOperation({ summary: 'Reset a user password as an administrator' })
  @ApiParam({ name: 'id', description: 'Target user MongoDB ObjectId', example: '507f1f77bcf86cd799439011' })
  @ApiResponse({ status: 201, description: 'Temporary password generated. It is returned only in this response.' })
  @ApiResponse({ status: 400, description: 'Invalid account ID or unsupported target account.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  @ApiResponse({ status: 404, description: 'Account not found.' })
  resetUserPassword(@Param('id') userId: string) {
    return this.administrationService.resetUserPassword(userId);
  }

  @Post('moderators')
  @ApiOperation({ summary: 'Create a moderator account for one hotel or airline' })
  @ApiResponse({ status: 201, description: 'Moderator created.' })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  @ApiResponse({ status: 409, description: 'Email is already in use.' })
  createModerator(@Body() dto: CreateModeratorDto) {
    return this.administrationService.createModerator(dto);
  }

  @Get('accounts')
  @ApiOperation({ summary: 'List accounts with filtering and pagination' })
  @ApiResponse({ status: 200, description: 'Paginated list of accounts.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  listAccounts(@Query() query: QueryAccountsDto) {
    return this.administrationService.listAccounts(query);
  }
}