
import {
  Controller,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  Get,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
} from '@nestjs/swagger';

import type { Request } from 'express';

import { FlightsService } from './flights.service';
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
