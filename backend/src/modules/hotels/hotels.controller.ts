import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Get,
  Query,
  Delete,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { Public } from '../../common/decorators/public.decorator';
import {
  CreateHotelDto,
  CreateRoomDto,
  UpdateHotelDto,
  UpdateHotelPoliciesDto,
  UpdateRoomDto,
  PaginationQueryDto,
  SetRoomAvailabilityDto,
  BlockRoomDto,
  RoomStatusQueryDto,
  HotelDetailsQueryDto,
} from './dto/hotels.dto';
import { HotelsService } from './hotels.service';
import { HotelSearchService } from './hotel-search.service';
import { HotelReservationsService } from './hotel-reservations.service';
import { HotelReservationsQueryDto } from './dto/hotel-reservations.dto';
import { HotelSearchQueryDto, RoomsAvailableQueryDto } from './dto/hotel-search.dto';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
};

@ApiTags('Hotels')
@Controller('hotels')
export class HotelsController {
  constructor(
    private readonly hotelsService: HotelsService,
    private readonly hotelSearch: HotelSearchService,
    private readonly reservations: HotelReservationsService,
  ) {}

  // HTL-11/12: public search. Declared BEFORE ':hotelId' so "search" is not read as a hotel id.
  @Get('search')
  @Public()
  @ApiOperation({
    summary: 'Search active hotels with free rooms for a stay (guests allowed)',
    description:
      'Give exactly one of city (a city_id) or country, plus checkIn, checkOut and guests (rooms defaults to 1). ' +
      'A room is free when it is active, the whole stay is inside its bookable ranges (ranges that touch count as one), no blocked range overlaps, ' +
      'and no Confirmed reservation or unexpired Pending Payment hold overlaps. A hotel matches when it has at least `rooms` free rooms ' +
      'whose best `rooms` capacities together hold the guests. minPrice/maxPrice and sortBy=price use the price per night of the cheapest free room; ' +
      'minRating excludes unrated hotels. Check-in cannot be in the past (UTC date). No match is a 200 with "No hotels found".',
  })
  search(@Query() query: HotelSearchQueryDto) {
    return this.hotelSearch.searchFromQuery(query);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Create a hotel' })
  create(@Body() dto: CreateHotelDto) {
    return this.hotelsService.create(dto);
  }

  @Patch(':hotelId')
  @Roles(UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Update a hotel profile' })
  update(
    @Param('hotelId') hotelId: string,
    @Body() dto: UpdateHotelDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelsService.update(
      hotelId,
      dto,
      request.user.userId,
    );
  } // Closes update before updateRoom starts.

  // Main route for policies; PATCH /hotels/:hotelId is the general profile update (same service method).
  @Put(':hotelId/policies')
  @Roles(UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Set hotel policies (check-in/out times and cancellation tiers)',
    description:
      'Moderator only, own hotel only. Applies the same update as PATCH /hotels/:id restricted to the policy fields.',
  })
  updatePolicies(
    @Param('hotelId') hotelId: string,
    @Body() dto: UpdateHotelPoliciesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelsService.update(hotelId, dto, request.user.userId);
  }

  // HTL-05: Update room beds, occupancy, or price.
  @Patch(':hotelId/rooms/:roomId')
  @Roles(UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Update room details' })
  updateRoom(
    @Param('hotelId') hotelId: string,
    @Param('roomId') roomId: string,
    @Body() dto: UpdateRoomDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelsService.updateRoom(
      hotelId,
      roomId,
      dto,
      request.user.userId,
    );
  }

  // HTL-03: Add a room to the moderator's assigned hotel.
@Post(':hotelId/rooms')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({ summary: 'Add a room to a hotel' })
createRoom(
  @Param('hotelId') hotelId: string,
  @Body() dto: CreateRoomDto,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.createRoom(
    hotelId,
    dto,
    request.user.userId,
  );
}

  // GEN-05: List a hotel's rooms in pages of 10.
@Get(':hotelId/rooms')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({ summary: 'List rooms for a hotel' })
listRooms(
  @Param('hotelId') hotelId: string,
  @Query() query: PaginationQueryDto,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.listRooms(
    hotelId,
    query.page,
    request.user.userId,
  );
}

// HTL-15: public list of the rooms free for the searched dates, with the total stay price.
@Get(':hotelId/rooms/available')
@Public()
@ApiOperation({
  summary: 'List the rooms of a hotel that are free for a stay, with price per night and total stay price (guests allowed)',
  description:
    'Uses the same free-room rule as hotel search and booking: ranges that touch count as one continuous range, blocked ranges, Confirmed reservations and unexpired holds exclude a room. checkOut must be after checkIn and checkIn cannot be in the past (UTC date).',
})
roomsAvailable(
  @Param('hotelId') hotelId: string,
  @Query() query: RoomsAvailableQueryDto,
) {
  return this.hotelSearch.availableRooms(hotelId, query);
}

// HTL-02: Show hotel profile, reviews, rating, and optionally available rooms.
@Get(':hotelId')
@Public()
@ApiOperation({ summary: 'Get hotel details and available rooms' })
getDetails(
  @Param('hotelId') hotelId: string,
  @Query() query: HotelDetailsQueryDto,
) {
  return this.hotelsService.getDetails(hotelId, query);
}

// HTL-04 / HTL-05: Update bookable date ranges.
@Patch(':hotelId/rooms/:roomId/availability')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({
  summary: 'Update room availability ranges',
  description:
    'Non-overlapping YYYY-MM-DD ranges, endDate exclusive. Ranges that touch (one ends the day the next starts) count as one continuous range, so a stay may span them; a real gap does not. Availability cannot be removed for dates with a Confirmed reservation or an unexpired hold (409).',
})
setRoomAvailability(
  @Param('hotelId') hotelId: string,
  @Param('roomId') roomId: string,
  @Body() dto: SetRoomAvailabilityDto,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.setRoomAvailability(
    hotelId,
    roomId,
    dto,
    request.user.userId,
  );
}

// HTL-06: Block room dates not covered by an active reservation.
@Patch(':hotelId/rooms/:roomId/blocks')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({ summary: 'Block room date ranges' })
blockRoomDates(
  @Param('hotelId') hotelId: string,
  @Param('roomId') roomId: string,
  @Body() dto: BlockRoomDto,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.blockRoomDates(
    hotelId,
    roomId,
    dto,
    request.user.userId,
  );
}

// HTL-06: Deactivate a room when it has no active reservations.
@Patch(':hotelId/rooms/:roomId/deactivate')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({ summary: 'Deactivate a room' })
deactivateRoom(
  @Param('hotelId') hotelId: string,
  @Param('roomId') roomId: string,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.deactivateRoom(
    hotelId,
    roomId,
    request.user.userId,
  );
}

@Delete(':hotelId/rooms/:roomId')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({
  summary: 'Delete a room that has never been reserved',
  description:
    'Rejected with 409 if ANY booking record references the room, including Expired and Cancelled ones, because booking history keeps pointing at the room. Use deactivate instead to take a reserved room out of sale.',
})
deleteRoom(
  @Param('hotelId') hotelId: string,
  @Param('roomId') roomId: string,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.deleteRoom(
    hotelId,
    roomId,
    request.user.userId,
  );
}

// HTL-22: the hotel's reservations (its moderator or an admin).
@Get(':hotelId/reservations')
@Roles(UserRole.ADMIN, UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({
  summary: 'Reservations of a hotel (its moderator or an admin)',
  description:
    'HTL-22. Guest name ("Deleted user" for a deactivated account), rooms, check-in/out, status, total and reference; newest first, 10 per page. Filters: status, and from/to (YYYY-MM-DD) keeping stays that overlap that range. Another hotel\'s moderator or a user gets 403.',
})
listReservations(
  @Param('hotelId') hotelId: string,
  @Query() query: HotelReservationsQueryDto,
  @Req() request: AuthenticatedRequest,
) {
  return this.reservations.list(request.user, hotelId, query);
}

// HTL-08 (main route): moderator view of each room's status for a date range.
@Get(':hotelId/availability')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({
  summary: 'Get each room status (Available, Booked, Blocked) for a date range',
  description:
    'Moderator only, own hotel only. startDate (inclusive) and endDate (exclusive) are required, YYYY-MM-DD. Each room is Available (free by the same rule as search and booking: ranges that touch count as one), Booked (a Confirmed reservation or unexpired hold overlaps; the reservation reference and status are returned) or Blocked (deactivated, blocked, or outside its bookable ranges). The public customer view is GET /hotels/:id/rooms/available.',
})
getAvailability(
  @Param('hotelId') hotelId: string,
  @Query() query: RoomStatusQueryDto,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.getRoomStatuses(
    hotelId,
    query,
    request.user.userId,
  );
}

// HTL-08: Show room status for a date range.
@Get(':hotelId/rooms/status')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({
  summary: 'Get room statuses for a date range',
  description: 'Legacy alias of GET /hotels/:id/availability.',
})
getRoomStatuses(
  @Param('hotelId') hotelId: string,
  @Query() query: RoomStatusQueryDto,
  @Req() request: AuthenticatedRequest,
) {
  return this.hotelsService.getRoomStatuses(
    hotelId,
    query,
    request.user.userId,
  );
}
}