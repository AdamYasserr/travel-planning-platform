import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdministrationController } from './administration.controller';
import { AdministrationService } from './administration.service';
import { User, UserSchema } from '../../users/user.schema';
import { Airline, AirlineSchema } from '../airlines/schemas/airline.schema';
import { Hotel, HotelSchema } from '../hotels/schemas/hotel.schema';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Airline.name, schema: AirlineSchema },
      { name: Hotel.name, schema: HotelSchema },
    ]),
    AuditLogsModule,
  ],
  controllers: [AdministrationController],
  providers: [AdministrationService],
  exports: [AdministrationService],
})
export class AdministrationModule {}