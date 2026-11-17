import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { UpdateProfileDto } from '../../users/dto/update-profile.dto';
import { DeactivateAccountDto } from '../../auth/dto/deactivate-account.dto';
import { clearAuthCookies } from '../../common/auth/auth-cookies';
import { UsersService } from './users.service';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
  };
}

@Controller('users')
@ApiTags('User Profiles')
@ApiCookieAuth('access_token')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Retrieve the authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Profile returned without password or token fields.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  async getProfile(@Req() request: AuthenticatedRequest) {
    return { user: await this.usersService.getProfile(request.user.userId) };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update permitted fields on the authenticated profile' })
  @ApiBody({ type: UpdateProfileDto })
  @ApiResponse({ status: 200, description: 'Profile updated successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid profile input.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  async updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ) {
    return {
      message: 'Profile updated successfully',
      user: await this.usersService.updateProfile(
        request.user.userId,
        dto,
      ),
    };
  }

  @Delete('me')
  @ApiOperation({ summary: 'Delete (deactivate) the authenticated account; requires { "confirm": true }' })
  @ApiBody({ type: DeactivateAccountDto })
  @ApiResponse({ status: 200, description: 'Account deactivated and auth cookies cleared.' })
  @ApiResponse({ status: 400, description: 'Confirmation is missing.' })
  @ApiResponse({ status: 409, description: 'Upcoming confirmed flight or hotel bookings exist.' })
  async deleteAccount(
    @Req() request: AuthenticatedRequest,
    @Body() dto: DeactivateAccountDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (dto.confirm !== true) {
      throw new BadRequestException('You must confirm account deactivation');
    }
    const result = await this.usersService.deactivateAccount(request.user.userId);
    clearAuthCookies(this.configService, response);
    return result;
  }
}
