
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
  ApiParam,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';

import type { Request } from 'express';

import { FlightsService } from './flights.service';
import { FlightSearchService } from './flight-search.service';
import { FlightSearchQueryDto } from './dto/flight-search.dto';

import {
  CreateFlightDto,
  UpdateFlightDto,
} from './dto/flights.dto';

import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
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
    private readonly flightSearchService: FlightSearchService,
  ) {}

  // FLT-11 / FLT-12 / FLT-15: Flight search (public).
  // Must stay above GET :id so "search" is not read as a flight ID.
  @Get('search')
  @Public()
  @ApiOperation({
    summary: 'Search flights (one-way or round trip)',
    description:
      'Scheduled flights of active airlines departing on the given LOCAL date at the departure airport. ' +
      'A flight is listed if at least one cabin has availableSeats >= adults + children (infants take no seat). ' +
      'Add returnDate for a round trip (reversed route, separate outboundPage/returnPage). ' +
      'Infants pay 10% of the fare. Results are paginated 10 per page.',
  })
  @ApiOkResponse({
    description:
      '{ tripType, passengers, outbound: { items, pagination, message? }, return?: { items, pagination, message? } }',
  })
  @ApiBadRequestResponse({
    description:
      'Invalid or unknown airport, same airports, invalid dates, returnDate before departureDate, no adult, infants > adults, or minPrice > maxPrice',
  })
  async search(@Query() query: FlightSearchQueryDto) {
    return this.flightSearchService.search(query);
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

  // FLT-17: Flight details (public). Keep `GET search` declared above this route.
  @Get(':id')
  @Public()
  @ApiOperation({
    summary: 'Get flight details',
    description:
      'Returns UTC departureTime/arrivalTime plus airport-local times with UTC offset and IANA time zone (GEN-06), duration in minutes, airline, every cabin (price, seats remaining, free bags, max bag weight), ' +
      'the airline baggage policy (extra baggage rules) and cancellation policy (null when not set), and bookability.',
  })
  @ApiParam({ name: 'id', description: 'Flight ID' })
  @ApiOkResponse({ description: 'Flight details' })
  @ApiBadRequestResponse({ description: 'Invalid flight ID' })
  @ApiNotFoundResponse({ description: 'Flight not found' })
  async findOne(@Param('id') id: string) {
    return this.flightsService.findById(id);
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
