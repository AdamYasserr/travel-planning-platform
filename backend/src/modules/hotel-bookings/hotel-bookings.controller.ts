import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Request,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { CreateHotelBookingDto } from './dto/hotel-bookings.dto';
import { HotelBookingsService } from './hotel-bookings.service';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
};

@ApiTags('Hotel Bookings')
@ApiCookieAuth('access_token')
@Controller('hotel-bookings')
@Roles(UserRole.USER)
export class HotelBookingsController {
  constructor(
    private readonly hotelBookingsService: HotelBookingsService,
  ) {}

  @Post('hold')
  async createHold(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateHotelBookingDto,
  ) {
    return this.hotelBookingsService.createHold(
      req.user.userId,
      dto,
    );
  }

  @Get('my-bookings')
  async getMyBookings(@Req() req: AuthenticatedRequest) {
    return this.hotelBookingsService.getMyBookings(
      req.user.userId,
    );
  }

  @Get(':bookingId')
  async getBookingDetails(
    @Req() req: AuthenticatedRequest,
    @Param('bookingId') bookingId: string,
  ) {
    return this.hotelBookingsService.getBookingDetails(
      req.user.userId,
      bookingId,
    );
  }
}