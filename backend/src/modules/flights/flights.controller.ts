
import {
  Controller,
  Post,
  Patch,
  Body,
  Param,
  Req,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
} from '@nestjs/swagger';

import type { Request } from 'express';

import { FlightsService } from './flights.service';

import {
  CreateFlightDto,
  UpdateFlightDto,
} from './dto/flights.dto';

import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
};

@ApiTags('Flights')
@Controller('flights')
export class FlightsController {
  constructor(
    private readonly flightsService: FlightsService,
  ) {}

  // FLT-03: Create a flight
  @Post()
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Create a flight' })
  async create(
    @Body() dto: CreateFlightDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flightsService.create(
      dto,
      request.user.userId,
    );
  }

  // FLT-05: Update a flight
  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Update flight details' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFlightDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flightsService.update(
      id,
      dto,
      request.user.userId,
    );
  }

  // FLT-06: Cancel a flight
  @Post(':id/cancel')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Cancel a flight' })
  async cancel(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flightsService.cancel(
      id,
      request.user.userId,
    );
  }

}
