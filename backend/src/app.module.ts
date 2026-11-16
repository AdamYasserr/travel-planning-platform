import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { AdministrationModule } from './modules/administration/administration.module';
import { ReportsModule } from './modules/reports/reports.module';
import { UsersModule } from './modules/users/users.module';
import { MediaModule } from './modules/media/media.module';
import { FxRatesModule } from './integrations/fx-rates/fx-rates.module';
import { HotelsModule } from './modules/hotels/hotels.module';
import { ItinerariesModule } from './modules/itineraries/itineraries.module';

// Hania - Flight Management Modules
import { AirlinesModule } from './modules/airlines/airlines.module';
import { FlightsModule } from './modules/flights/flights.module';

import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { AirportsModule } from './modules/airports/airports.module';
import { BlogModule } from './modules/blog/blog.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
    }),
    DatabaseModule,
    AuthModule,
    AdministrationModule,
    ReportsModule,
    UsersModule,
    MediaModule,
    HotelsModule,
    ItinerariesModule,
    FxRatesModule,

    // Hania - Flight Management Modules
    AirlinesModule,
    FlightsModule,
    AirportsModule,
    BlogModule,

    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
