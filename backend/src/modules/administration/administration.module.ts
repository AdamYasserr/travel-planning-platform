import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AdministrationController } from './administration.controller';
import { AdministrationService } from './administration.service';
import { User, UserSchema } from '../../users/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [AdministrationController],
  providers: [AdministrationService],
  exports: [AdministrationService],
})
export class AdministrationModule {}
