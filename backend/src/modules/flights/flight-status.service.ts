
import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Flight,
  FlightStatus,
} from './schemas/flight.schema';

@Injectable()
export class FlightStatusService {
  constructor(
    @InjectModel(Flight.name)
    private readonly flightModel: Model<Flight>,
  ) {}

  // FLT-30: Automatically mark departed flights
  @Cron(CronExpression.EVERY_MINUTE)
  async updateDepartedFlights(): Promise<void> {
    await this.flightModel.updateMany(
      {
        status: FlightStatus.SCHEDULED,
        departureTime: { $lte: new Date() },
      },
      {
        $set: {
          status: FlightStatus.DEPARTED,
        },
      },
    ).exec();
  }
}
