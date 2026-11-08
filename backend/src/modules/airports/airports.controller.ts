
import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

import { AirportsService } from './airports.service';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('Airports')
@Controller('airports')
export class AirportsController {
  constructor(
    private readonly airportsService: AirportsService,
  ) {}

  // FLT-02: Public airport listing
  @Get()
  @Public()
  @ApiOperation({ summary: 'List available airports' })
  async findAll() {
    return this.airportsService.findAll();
  }
}
