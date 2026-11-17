import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Res,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response, Request } from 'express';

import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeactivateAccountDto } from './dto/deactivate-account.dto';
import { UpdateProfileDto } from '../users/dto/update-profile.dto';
import { Public } from '../common/decorators/public.decorator';
import { AllowPasswordChange } from '../common/decorators/allow-password-change.decorator';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from '../common/auth/auth-cookies';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

@Controller('auth')
@ApiTags('Authentication')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private setAuthCookies(
    response: Response,
    tokens: { accessToken: string; refreshToken: string },
  ) {
    setAuthCookies(this.configService, response, tokens);
  }

  private clearAuthCookies(response: Response) {
    clearAuthCookies(this.configService, response);
  }

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a user account' })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({ status: 201, description: 'Account created successfully.' })
  @ApiResponse({ status: 409, description: 'Email is already registered.' })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Log in and set HTTP-only authentication cookies' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 201, description: 'Login successful.' })
  @ApiResponse({ status: 401, description: 'Invalid credentials.' })
  @ApiResponse({ status: 403, description: 'Account is unavailable.' })
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(loginDto);

    this.setAuthCookies(response, result);

    return {
      message: 'Login successful',
      user: result.user,
    };
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh the authenticated session cookie' })
  @ApiResponse({ status: 201, description: 'Session refreshed successfully.' })
  @ApiResponse({ status: 401, description: 'Refresh cookie is missing or invalid.' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const refreshToken = request.cookies?.[REFRESH_COOKIE];

    const result = await this.authService.refreshSession(refreshToken);

    this.setAuthCookies(response, result);

    return {
      message: 'Session refreshed successfully',
      user: result.user,
    };
  }

  @Public()
  @Post('logout')
  @ApiOperation({ summary: 'Log out and clear authentication cookies' })
  @ApiResponse({ status: 201, description: 'Logged out successfully.' })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authService.logout(
      request.cookies?.[REFRESH_COOKIE],
      request.cookies?.[ACCESS_COOKIE],
    );

    this.clearAuthCookies(response);

    return {
      message: 'Logged out successfully',
    };
  }

  @Delete('account')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Deactivate the authenticated account' })
  @ApiBody({ type: DeactivateAccountDto })
  @ApiResponse({ status: 200, description: 'Account deactivated successfully.' })
  @ApiResponse({ status: 400, description: 'Confirmation is missing or invalid.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  async deactivateAccount(
    @Req() request: AuthenticatedRequest,
    @Body() deactivateAccountDto: DeactivateAccountDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (deactivateAccountDto.confirm !== true) {
      throw new BadRequestException('You must confirm account deactivation');
    }

    const result = await this.authService.deactivateAccount(
      request.user.userId,
    );

    this.clearAuthCookies(response);

    return result;
  }

  // Allowed while a temporary password is pending so the client can read mustChangePassword.
  @AllowPasswordChange()
  @Get('me')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Get the authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Current user returned without sensitive fields.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  async getMe(@Req() request: AuthenticatedRequest) {
    return {
      user: await this.authService.getCurrentUser(request.user.userId),
    };
  }

  @AllowPasswordChange()
  @Post('change-password')
  @Patch('change-password')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Change the authenticated user password (POST and PATCH are equivalent)' })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 201, description: 'Password changed and sessions cleared.' })
  @ApiResponse({ status: 400, description: 'Invalid password input.' })
  @ApiResponse({ status: 401, description: 'Authentication or current password is invalid.' })
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() changePasswordDto: ChangePasswordDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.changePassword(
      request.user.userId,
      changePasswordDto,
    );

    this.clearAuthCookies(response);

    return result;
  }

  @Patch('profile')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Update the authenticated user profile' })
  @ApiBody({ type: UpdateProfileDto })
  @ApiResponse({ status: 200, description: 'Profile updated successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid profile input.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  async updateProfile(
    @Req() request: AuthenticatedRequest,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(
      request.user.userId,
      updateProfileDto,
    );
  }
}