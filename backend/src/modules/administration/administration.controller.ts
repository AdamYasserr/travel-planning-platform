import {
  Controller,
  Param,
  Post,
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
}
