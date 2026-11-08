
import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Param,
  Body,
  Req,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
} from '@nestjs/swagger';

import type { Request } from 'express';

import { AirlinesService } from './airlines.service';

import {
  CreateAirlineDto,
  UpdateAirlineDto,
} from './dto/airlines.dto';

import {
  UpdateBaggagePolicyDto,
} from './dto/baggage-policy.dto';

import {
  UpdateCancellationPolicyDto,
} from './dto/cancellation-policy.dto';

import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
};

@ApiTags('Airlines')
@Controller('airlines')
export class AirlinesController {
  constructor(
    private readonly airlinesService: AirlinesService,
  ) {}

  // FLT-01: Only administrators can create airlines
  @Post()
  @Roles(UserRole.ADMIN)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Create an airline' })
  async create(
    @Body() createAirlineDto: CreateAirlineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.airlinesService.create(
      createAirlineDto,
      request.user.userId,
    );
  }

  // FLT-01: Public airline details
  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get airline by ID' })
  async findOne(@Param('id') id: string) {
    return this.airlinesService.findOne(id);
  }

  // FLT-01: Admins or assigned airline moderators
  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Update airline details' })
  async update(
    @Param('id') id: string,
    @Body() updateAirlineDto: UpdateAirlineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.airlinesService.update(
      id,
      updateAirlineDto,
      request.user.userId,
    );
  }

  // FLT-08: Get airline baggage policy
  @Get(':id/baggage-policy')
  @ApiOperation({ summary: 'Get airline baggage policy' })
  async getBaggagePolicy(
    @Param('id') id: string,
  ) {
    return this.airlinesService.getBaggagePolicy(id);
  }

  // FLT-08: Create or update baggage policy
  @Put(':id/baggage-policy')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Create or update airline baggage policy',
  })
  async updateBaggagePolicy(
    @Param('id') id: string,
    @Body() dto: UpdateBaggagePolicyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.airlinesService.updateBaggagePolicy(
      id,
      dto,
      request.user.userId,
    );
  }

  // FLT-09: Get airline cancellation policy
  @Get(':id/cancellation-policy')
  @ApiOperation({
    summary: 'Get airline cancellation policy',
  })
  async getCancellationPolicy(
    @Param('id') id: string,
  ) {
    return this.airlinesService.getCancellationPolicy(id);
  }

  // FLT-09: Create or update cancellation policy
  @Put(':id/cancellation-policy')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Create or update airline cancellation policy',
  })
  async updateCancellationPolicy(
    @Param('id') id: string,
    @Body() dto: UpdateCancellationPolicyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.airlinesService.updateCancellationPolicy(
      id,
      dto,
      request.user.userId,
    );
  }
}
