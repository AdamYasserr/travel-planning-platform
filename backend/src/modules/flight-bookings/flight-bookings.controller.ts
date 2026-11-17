import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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

  @Post('hold')
  @ApiOperation({
    summary: 'Hold seats for a flight (creates a Pending Payment booking)',
    description: 'Creating the booking IS the hold: POST /flight-bookings and POST /flight-bookings/hold are the same operation (a Pending Payment booking that holds the seats for 10 minutes). Do not call both: calling both for the same trip creates TWO pending bookings and holds the seats twice.',
  })
  hold(
    @Body() dto: CreateFlightBookingDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.flightBookingsService.create(request.user.userId, dto);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a flight booking hold',
    description: 'Creating the booking IS the hold: POST /flight-bookings and POST /flight-bookings/hold are the same operation (a Pending Payment booking that holds the seats for 10 minutes). Do not call both: calling both for the same trip creates TWO pending bookings and holds the seats twice. Legacy alias of POST /flight-bookings/hold.',
  })
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
      query.group,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a flight booking' })
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.flightBookingsService.getForUser(request.user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a flight booking (unpaid hold or confirmed booking)' })
  cancelBooking(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.flightBookingsService.cancel(request.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancel a pending flight booking hold',
    description: 'Legacy alias of POST /flight-bookings/:id/cancel.',
  })
  cancel(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.flightBookingsService.cancel(request.user.userId, id);
  }
}
