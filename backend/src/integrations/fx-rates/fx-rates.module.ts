import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { FxRatesController } from './fx-rates.controller';
import { FxRatesService } from './fx-rates.service';

@Module({
  imports: [HttpModule],
  controllers: [FxRatesController],
  providers: [FxRatesService],
  exports: [FxRatesService],
})
export class FxRatesModule {}