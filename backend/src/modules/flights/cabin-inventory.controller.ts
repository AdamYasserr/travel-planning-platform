
import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Req,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiCookieAuth,
} from '@nestjs/swagger';

import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { CabinInventoryService } from './cabin-inventory.service';

import {
  CreateCabinInventoryDto,
  UpdateCabinInventoryDto,
} from './dto/cabin-inventory.dto';

import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
};

@ApiTags('Cabin Inventory')
@Controller('flights/:flightId/cabins')
export class CabinInventoryController {
  constructor(
    private readonly inventoryService: CabinInventoryService,
  ) {}

  // FLT-04: Create cabin inventory for a flight
  @Post()
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Create cabin inventory' })
  async create(
    @Param('flightId') flightId: string,
    @Body() dto: CreateCabinInventoryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inventoryService.create(
      flightId,
      dto,
      request.user.userId,
    );
  }

  // FLT-04: Get cabin inventory for a flight
  @Get()
  @Public()
  @ApiOperation({ summary: 'Get flight cabin inventory' })
  async findByFlight(
    @Param('flightId') flightId: string,
  ) {
    return this.inventoryService.findByFlight(flightId);
  }

  // FLT-04 / FLT-05: Update cabin inventory
  @Patch(':cabinId')
  @Roles(UserRole.ADMIN, UserRole.MODERATOR)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Update cabin inventory' })
  async update(
    @Param('flightId') flightId: string,
    @Param('cabinId') cabinId: string,
    @Body() dto: UpdateCabinInventoryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inventoryService.update(
      flightId,
      cabinId,
      dto,
      request.user.userId,
    );
  }
}
