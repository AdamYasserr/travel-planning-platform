import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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
import {
  CreateModeratorDto,
  ProviderType,
} from './dto/create-moderator.dto';
import { QueryAccountsDto } from './dto/query-accounts.dto';
import { SuspendAccountDto } from './dto/suspend-account.dto';
import { ProviderStatusDto } from './dto/deactivate-provider.dto';

interface AuthenticatedRequest {
  user: { userId: string };
}

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
  resetUserPassword(
    @Param('id') userId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.administrationService.resetUserPassword(userId, req.user.userId);
  }

  @Post('moderators')
  @ApiOperation({ summary: 'Create a moderator account for one hotel or airline' })
  @ApiResponse({ status: 201, description: 'Moderator created.' })
  @ApiResponse({ status: 400, description: 'Validation failed.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  @ApiResponse({ status: 404, description: 'Hotel or airline not found.' })
  @ApiResponse({ status: 409, description: 'Email is already in use.' })
  createModerator(
    @Body() dto: CreateModeratorDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.administrationService.createModerator(dto, req.user.userId);
  }

  @Get('accounts')
  @ApiOperation({ summary: 'List accounts with filtering and pagination' })
  @ApiResponse({ status: 200, description: 'Paginated list of accounts.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  listAccounts(@Query() query: QueryAccountsDto) {
    return this.administrationService.listAccounts(query);
  }

  @Patch('accounts/:id/suspend')
  @ApiOperation({ summary: 'Suspend a user or moderator account' })
  @ApiParam({ name: 'id', description: 'Target user MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Account suspended.' })
  @ApiResponse({ status: 400, description: 'Invalid id or account cannot be suspended.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  @ApiResponse({ status: 404, description: 'Account not found.' })
  @ApiResponse({ status: 409, description: 'Account is already suspended.' })
  suspendAccount(
    @Param('id') userId: string,
    @Body() dto: SuspendAccountDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.administrationService.suspendAccount(userId, dto, req.user.userId);
  }

  @Patch('accounts/:id/reactivate')
  @ApiOperation({ summary: 'Reactivate a suspended account' })
  @ApiParam({ name: 'id', description: 'Target user MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Account reactivated.' })
  @ApiResponse({ status: 400, description: 'Invalid account id.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  @ApiResponse({ status: 404, description: 'Account not found.' })
  @ApiResponse({ status: 409, description: 'Account is not suspended.' })
  reactivateAccount(
    @Param('id') userId: string,
    @Body() dto: SuspendAccountDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.administrationService.reactivateAccount(userId, dto, req.user.userId);
  }

  @Patch('providers/:type/:id/deactivate')
  @ApiOperation({ summary: 'Deactivate a hotel or airline (hidden from search, cannot be booked)' })
  @ApiParam({ name: 'type', enum: ProviderType })
  @ApiParam({ name: 'id', description: 'Hotel or airline MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Provider deactivated. Existing Confirmed bookings stay valid.' })
  @ApiResponse({ status: 400, description: 'Invalid type or id.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  @ApiResponse({ status: 404, description: 'Provider not found.' })
  @ApiResponse({ status: 409, description: 'Provider is already deactivated.' })
  deactivateProvider(
    @Param('type', new ParseEnumPipe(ProviderType)) type: ProviderType,
    @Param('id') id: string,
    @Body() dto: ProviderStatusDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.administrationService.setProviderActive(type, id, false, dto, req.user.userId);
  }

  @Patch('providers/:type/:id/reactivate')
  @ApiOperation({ summary: 'Reactivate a deactivated hotel or airline' })
  @ApiParam({ name: 'type', enum: ProviderType })
  @ApiParam({ name: 'id', description: 'Hotel or airline MongoDB ObjectId' })
  @ApiResponse({ status: 200, description: 'Provider reactivated.' })
  @ApiResponse({ status: 400, description: 'Invalid type or id.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 403, description: 'Administrator role is required.' })
  @ApiResponse({ status: 404, description: 'Provider not found.' })
  @ApiResponse({ status: 409, description: 'Provider is already active.' })
  reactivateProvider(
    @Param('type', new ParseEnumPipe(ProviderType)) type: ProviderType,
    @Param('id') id: string,
    @Body() dto: ProviderStatusDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.administrationService.setProviderActive(type, id, true, dto, req.user.userId);
  }
}