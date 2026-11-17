import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  CreateFlightBookingDto,
  FlightBookingListQueryDto,
} from './dto/flight-bookings.dto';
import { FlightBookingsService } from './flight-bookings.service';

type AuthenticatedRequest = Request & {
  user: { userId: string };
};

@ApiTags('Flight Bookings')
@ApiCookieAuth('access_token')
@Controller('flight-bookings')
export class FlightBookingsController {
  constructor(private readonly flightBookingsService: FlightBookingsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a flight booking hold' })
  create(
    @Body() dto: CreateFlightBookingDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flightBookingsService.create(request.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the current user’s flight bookings' })
  list(
    @Query() query: FlightBookingListQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flightBookingsService.listForUser(
      request.user.userId,
      query.page,
      query.limit,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a flight booking' })
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.flightBookingsService.getForUser(request.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancel a pending flight booking hold' })
  cancel(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.flightBookingsService.cancel(request.user.userId, id);
  }
}
