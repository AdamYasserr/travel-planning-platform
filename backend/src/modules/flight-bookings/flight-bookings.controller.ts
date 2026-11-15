import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { FlightBookingsService } from './flight-bookings.service';
import {
  CancelFlightBookingDto,
  CreateFlightBookingDto,
  FlightBookingsPageQueryDto,
} from './dto/flight-bookings.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
};

// TODO(ASSUMPTION): Booking endpoints are for registered travellers (role
// "user"); admins and moderators manage bookings through their own endpoints.
@ApiTags('Flight Bookings')
@ApiCookieAuth('access_token')
@Controller('flight-bookings')
export class FlightBookingsController {
  constructor(private readonly bookingsService: FlightBookingsService) {}

  // FLT-19 / FLT-21: Validate passengers and baggage, return the summary
  @Post()
  @Roles(UserRole.USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Booking summary (FLT-19, FLT-21)',
    description:
      'Validates passengers and extra baggage and returns flights, passengers, baggage and total. Reserves no seats and saves nothing.',
  })
  @ApiOkResponse({ description: 'Booking summary' })
  @ApiBadRequestResponse({ description: 'Invalid passengers or baggage' })
  @ApiNotFoundResponse({ description: 'Flight not found' })
  @ApiConflictResponse({
    description: 'Flight not bookable, airline inactive, cabin missing or not enough seats',
  })
  async summary(@Body() dto: CreateFlightBookingDto) {
    return this.bookingsService.previewBooking(dto);
  }

  // FLT-22: Hold seats for 10 minutes
  @Post('hold')
  @Roles(UserRole.USER)
  @ApiOperation({
    summary: 'Hold seats and create a Pending Payment booking (FLT-22)',
    description:
      'Same body as the summary. Atomically reserves adults + children seats on every segment (infants take no seat) and creates the booking with holdExpiresAt = now + 10 minutes.',
  })
  @ApiCreatedResponse({ description: 'Pending Payment booking' })
  @ApiBadRequestResponse({ description: 'Invalid passengers or baggage' })
  @ApiNotFoundResponse({ description: 'Flight not found' })
  @ApiConflictResponse({ description: 'Not enough seats or flight not bookable' })
  async hold(
    @Body() dto: CreateFlightBookingDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bookingsService.createHold(dto, request.user.userId);
  }

  // FLT-25: Own bookings
  @Get()
  @Roles(UserRole.USER)
  @ApiOperation({
    summary: 'My flight bookings (FLT-25)',
    description:
      'Grouped as upcoming, past and cancelled. Expired holds are not listed.',
  })
  @ApiOkResponse({ description: '{ upcoming, past, cancelled }' })
  async findMine(@Req() request: AuthenticatedRequest) {
    return this.bookingsService.findMine(request.user.userId);
  }

  // FLT-25: One own booking
  @Get(':id')
  @Roles(UserRole.USER)
  @ApiOperation({ summary: 'Flight booking details (FLT-25)' })
  @ApiParam({ name: 'id', description: 'Booking ID' })
  @ApiOkResponse({ description: 'Booking details' })
  @ApiBadRequestResponse({ description: 'Invalid booking ID' })
  @ApiNotFoundResponse({ description: 'Not found or not your booking' })
  async findOne(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bookingsService.findMineById(request.user.userId, id);
  }

  // FLT-23: E-ticket
  @Get(':id/e-ticket')
  @Roles(UserRole.USER)
  @ApiOperation({
    summary: 'E-ticket (FLT-23)',
    description: 'JSON e-ticket for Confirmed bookings only.',
  })
  @ApiParam({ name: 'id', description: 'Booking ID' })
  @ApiOkResponse({ description: 'E-ticket' })
  @ApiNotFoundResponse({ description: 'Not found or not your booking' })
  @ApiConflictResponse({ description: 'Booking is not Confirmed' })
  async eTicket(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bookingsService.getETicket(request.user.userId, id);
  }

  // PAY-02: Record policy acceptance
  @Post(':id/accept-policies')
  @Roles(UserRole.USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept booking policies (PAY-02)',
    description:
      'Records policiesAcceptedAt for your Pending Payment booking. Payment will require it.',
  })
  @ApiParam({ name: 'id', description: 'Booking ID' })
  @ApiOkResponse({ description: '{ bookingId, policiesAcceptedAt }' })
  @ApiNotFoundResponse({ description: 'Not found or not your booking' })
  @ApiConflictResponse({ description: 'Not Pending Payment or hold expired' })
  async acceptPolicies(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bookingsService.acceptPolicies(request.user.userId, id);
  }

  // FLT-26: Cancel (preview, then confirm)
  @Post(':id/cancel')
  @Roles(UserRole.USER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a Confirmed booking (FLT-26)',
    description:
      'Without confirm (or confirm=false) returns the refund preview from the airline cancellation tiers. With confirm=true cancels, returns the seats and requests the refund.',
  })
  @ApiParam({ name: 'id', description: 'Booking ID' })
  @ApiOkResponse({ description: 'Refund preview or cancelled booking' })
  @ApiNotFoundResponse({ description: 'Not found or not your booking' })
  @ApiConflictResponse({
    description: 'Not Confirmed (Pending holds only expire) or already departed',
  })
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelFlightBookingDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bookingsService.cancel(request.user.userId, id, dto);
  }
}

// FLT-29: Airline view of a flight's bookings. Lives in the flight-bookings
// module; FlightsController is not changed.
@ApiTags('Flight Bookings (Airline)')
@ApiCookieAuth('access_token')
@Controller('flights')
export class FlightBookingsManagementController {
  constructor(private readonly bookingsService: FlightBookingsService) {}

  @Get(':id/bookings')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiOperation({
    summary: "Bookings of a flight (FLT-29)",
    description:
      "Moderators: only flights of their own airline. Admins: all flights. Shows reference, passenger names, cabin, seats and status, plus seats remaining per cabin. 10 per page.",
  })
  @ApiParam({ name: 'id', description: 'Flight ID' })
  @ApiOkResponse({
    description: '{ flight, seatsRemaining, items, pagination }',
  })
  @ApiForbiddenResponse({ description: 'Not your airline' })
  @ApiNotFoundResponse({ description: 'Flight not found' })
  async flightBookings(
    @Param('id') id: string,
    @Query() query: FlightBookingsPageQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.bookingsService.findFlightBookings(
      request.user.userId,
      id,
      query.page,
    );
  }

  @Get(':id/passengers/export')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiProduces('text/csv')
  @ApiOperation({
    summary: 'Export passenger list as CSV (FLT-29)',
    description:
      'Columns: booking reference, passenger name, passenger type, cabin, seats, status. No passport numbers or dates of birth.',
  })
  @ApiParam({ name: 'id', description: 'Flight ID' })
  @ApiOkResponse({ description: 'CSV file' })
  @ApiForbiddenResponse({ description: 'Not your airline' })
  @ApiNotFoundResponse({ description: 'Flight not found' })
  async exportPassengers(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { filename, csv } =
      await this.bookingsService.exportFlightPassengers(
        request.user.userId,
        id,
      );

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );

    return csv;
  }
}
