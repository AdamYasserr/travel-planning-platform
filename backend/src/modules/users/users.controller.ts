import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { UpdateProfileDto } from '../../users/dto/update-profile.dto';
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
  constructor(private readonly usersService: UsersService) {}

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
}