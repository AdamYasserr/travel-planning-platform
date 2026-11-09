import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
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
  UpdateRoomDto,
  PaginationQueryDto,
  SetRoomAvailabilityDto,
  BlockRoomDto,
  RoomStatusQueryDto,
  HotelDetailsQueryDto,
} from './dto/hotels.dto';
import { HotelsService } from './hotels.service';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
};

@ApiTags('Hotels')
@Controller('hotels')
export class HotelsController {
  constructor(private readonly hotelsService: HotelsService) {}

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
@ApiOperation({ summary: 'Update room availability ranges' })
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
@ApiOperation({ summary: 'Delete a room that has never been reserved' })
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

// HTL-08: Show room status for a date range.
@Get(':hotelId/rooms/status')
@Roles(UserRole.MODERATOR)
@ApiCookieAuth('access_token')
@ApiOperation({ summary: 'Get room statuses for a date range' })
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