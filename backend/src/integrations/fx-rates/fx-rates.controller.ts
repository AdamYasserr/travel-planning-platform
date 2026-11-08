import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import {
  FxConvertQueryDto,
  FxRateQueryDto,
} from './dto/fx-rates.dto';
import { FxRatesService } from './fx-rates.service';

@Controller('fx-rates')
@ApiTags('FX Rates')
export class FxRatesController {
  constructor(private readonly fxRatesService: FxRatesService) {}

  @Get('rate')
  @ApiOperation({ summary: 'Get the current exchange rate for a currency pair' })
  @ApiQuery({ name: 'from', required: true, description: 'Three-letter source currency code', example: 'USD' })
  @ApiQuery({ name: 'to', required: true, description: 'Three-letter target currency code', example: 'EGP' })
  @ApiResponse({ status: 200, description: 'Exchange rate returned.' })
  @ApiResponse({ status: 400, description: 'Currency code is invalid or unsupported.' })
  @ApiResponse({ status: 503, description: 'Exchange-rate provider is unavailable and no usable cached rate exists.' })
  getRate(@Query() query: FxRateQueryDto) {
    return this.fxRatesService.getRate(query.from, query.to);
  }

  @Get('convert')
  @ApiOperation({ summary: 'Convert an amount between currencies' })
  @ApiQuery({ name: 'amount', required: true, description: 'Positive finite amount to convert', example: 100 })
  @ApiQuery({ name: 'from', required: true, description: 'Three-letter source currency code', example: 'USD' })
  @ApiQuery({ name: 'to', required: true, description: 'Three-letter target currency code', example: 'EGP' })
  @ApiResponse({ status: 200, description: 'Converted amount and rate returned.' })
  @ApiResponse({ status: 400, description: 'Amount or currency code is invalid or unsupported.' })
  @ApiResponse({ status: 503, description: 'Exchange-rate provider is unavailable and no usable cached rate exists.' })
  convert(@Query() query: FxConvertQueryDto) {
    return this.fxRatesService.convert(
      query.amount,
      query.from,
      query.to,
    );
  }
}
