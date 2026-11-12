import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FxRatesController } from './fx-rates.controller';
import { FxRatesService } from './fx-rates.service';
import {
  ExchangeRate,
  ExchangeRateSchema,
} from './schemas/exchange-rate.schema';

@Module({
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      {
        name: ExchangeRate.name,
        schema: ExchangeRateSchema,
      },
    ]),
  ],
  controllers: [FxRatesController],
  providers: [FxRatesService],
  exports: [FxRatesService],
})
export class FxRatesModule {}