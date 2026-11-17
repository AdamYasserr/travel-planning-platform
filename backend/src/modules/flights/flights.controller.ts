
import {
  HttpCode,
  Controller,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Get,
  StreamableFile,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
} from '@nestjs/swagger';

import type { Request } from 'express';

import { FlightsService } from './flights.service';
import { FlightManifestService } from './flight-manifest.service';
import { FlightBookingsQueryDto } from './dto/flight-manifest.dto';
import { FlightSearchService } from './flight-search.service';
import { FlightSearchQueryDto } from './dto/flight-search.dto';
import { Public } from '../../common/decorators/public.decorator';

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
    private readonly flightSearch: FlightSearchService,
    private readonly manifest: FlightManifestService,
  ) {}

  // FLT-11/12/15: public search. Declared BEFORE ':id' so "search" is not read as a flight id.
  @Get('search')
  @Public()
  @ApiOperation({
    summary: 'Search Scheduled flights (guests allowed)',
    description:
      'Scheduled, not-yet-departed flights of active airlines with enough free seats (adults + children) on the LOCAL departure date. ' +
      'Add returnDate for a round trip: the response then also has return options (destination to origin, local date at the destination, departing after the earliest outbound arrival). ' +
      'Infants take no seat and pay 10% of the fare. Prices are returned as stored (one platform currency). An empty result is a 200 with "No flights found".',
  })
  search(@Query() query: FlightSearchQueryDto) {
    return this.flightSearch.searchFromQuery(query);
  }

  // FLT-29: the airline's view of a flight (its moderator or an admin).
  @Get(':id/bookings')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Bookings on a flight (its airline moderator or an admin)',
    description: 'FLT-29. One row per booking (reference, status, passengers, cabin, passenger counts by type, booked at), newest first, 10 per page, optional `status` filter; plus the seats left in each cabin. Another airline\'s moderator or a user gets 403.',
  })
  bookings(@Param('id') id: string, @Query() query: FlightBookingsQueryDto, @Req() request: AuthenticatedRequest) {
    return this.manifest.listBookings(request.user.userId, id, query);
  }

  @Get(':id/passengers/export')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Passenger list as CSV (its airline moderator or an admin)',
    description: 'FLT-29. text/csv attachment, one row per passenger of every Confirmed or Completed booking: booking_reference, full_name, type (adult/child/infant on the departure day), cabin, passport_or_id, nationality, status. Cells that could start a spreadsheet formula are prefixed with a single quote.',
  })
  async exportPassengers(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    const { filename, csv } = await this.manifest.exportPassengers(request.user.userId, id);
    const body = Buffer.from(csv, 'utf8');
    return new StreamableFile(body, { type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${filename}"`, length: body.length });
  }

  // FLT-17: public flight details (placed after 'search').
  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Flight details: times in local and UTC, cabins, baggage, cancellation policy (guests allowed)' })
  details(@Param('id') id: string) {
    return this.flightSearch.details(id);
  }

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
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a flight (its airline moderator or an admin)',
    description:
      'FLT-06. In one transaction: the flight becomes Cancelled (hidden from search, no longer bookable), Pending Payment holds on it are expired and their seats released, and every Confirmed booking becomes Cancelled with a 100% refund (PAY-03). Completed bookings are not touched. 409 when the flight is already cancelled or has departed; 403 for another airline.',
  })
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
