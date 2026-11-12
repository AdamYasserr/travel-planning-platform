import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdministrationController } from './administration.controller';
import { AdministrationService } from './administration.service';
import { User, UserSchema } from '../../users/user.schema';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
    ]),
    AuditLogsModule,
  ],
  controllers: [AdministrationController],
  providers: [AdministrationService],
  exports: [AdministrationService],
})
export class AdministrationModule {}