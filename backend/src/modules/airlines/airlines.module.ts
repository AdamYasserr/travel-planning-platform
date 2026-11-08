
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Airline,
  AirlineSchema,
} from './schemas/airline.schema';

import {
  BaggagePolicy,
  BaggagePolicySchema,
} from './schemas/baggage-policy.schema';

import {
  CancellationPolicy,
  CancellationPolicySchema,
} from './schemas/cancellation-policy.schema';

import { User, UserSchema } from '../../users/user.schema';

import { AirlinesService } from './airlines.service';
import { AirlinesController } from './airlines.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Airline.name,
        schema: AirlineSchema,
      },
      {
        name: BaggagePolicy.name,
        schema: BaggagePolicySchema,
      },
      {
        name: CancellationPolicy.name,
        schema: CancellationPolicySchema,
      },
      {
        name: User.name,
        schema: UserSchema,
      },
    ]),
  ],
  controllers: [AirlinesController],
  providers: [AirlinesService],
  exports: [MongooseModule, AirlinesService],
})
export class AirlinesModule {}
