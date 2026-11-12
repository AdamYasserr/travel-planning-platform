import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ReorderItineraryDaysDto,
  UpdateItineraryDto,
} from './dto/itineraries.dto';
import { ItinerariesService } from './itineraries.service';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
  };
};

@ApiTags('Itineraries')
@Controller('itineraries')
export class ItinerariesController {
  constructor(
    private readonly itinerariesService: ItinerariesService,
  ) {}

  @Get()
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'List your itineraries' })
  findMine(@Req() request: AuthenticatedRequest) {
    return this.itinerariesService.findMine(request.user.userId);
  }

  @Get(':id')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'View one of your itineraries' })
  findMineById(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.itinerariesService.findMineById(
      id,
      request.user.userId,
    );
  }

  @Patch(':id')
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Update your itinerary details and visibility',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateItineraryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.itinerariesService.update(
      id,
      dto,
      request.user.userId,
    );
  }

  @Get(':id/budget-summary')
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'View your itinerary budget in your preferred currency',
  })
  getBudgetSummary(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.itinerariesService.getBudgetSummary(
      id,
      request.user.userId,
    );
  }

  @Delete(':id/days/:dayId')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Delete a day from your itinerary' })
  deleteDay(
    @Param('id') itineraryId: string,
    @Param('dayId') dayId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.itinerariesService.deleteDay(
      itineraryId,
      dayId,
      request.user.userId,
    );
  }

  @Patch(':id/days/reorder')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Move a day to a new position' })
  reorderDay(
    @Param('id') itineraryId: string,
    @Body() dto: ReorderItineraryDaysDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.itinerariesService.reorderDay(
      itineraryId,
      dto.dayId,
      dto.newPosition,
      request.user.userId,
    );
  }
}