import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { ReferenceQueryDto } from './dto/reference-query.dto';
import { ReferenceDataService } from './reference-data.service';
@ApiTags('Reference Data') @Controller() @Public()
export class ReferenceDataController {
  constructor(private readonly data: ReferenceDataService) {}
  @Get('countries') @ApiOperation({ summary: 'List official reference countries' }) countries(@Query() q: ReferenceQueryDto) { return this.data.countriesList(q); }
  @Get('cities') @ApiOperation({ summary: 'List cities, optionally filtered by country code (parentId, e.g. EG)' }) cities(@Query() q: ReferenceQueryDto) { return this.data.citiesList(q); }
  @Get('attractions') @ApiOperation({ summary: 'List attractions, optionally filtered by city_id (parentId, e.g. cairo)' }) attractions(@Query() q: ReferenceQueryDto) { return this.data.attractionsList(q); }
  @Get('currencies') @ApiOperation({ summary: 'List distinct supported country currencies' }) currencies() { return this.data.currencies(); }
}
