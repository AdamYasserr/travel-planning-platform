import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  Req,
  Get,
  Query,
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

// HTL-02: Show a public hotel's profile and policies.
@Get(':hotelId')
@Public()
@ApiOperation({ summary: 'Get hotel details' })
getDetails(@Param('hotelId') hotelId: string) {
  return this.hotelsService.getDetails(hotelId);
}
}