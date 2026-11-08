
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  Airport,
  AirportDocument,
} from './schemas/airport.schema';

@Injectable()
export class AirportsService {
  constructor(
    @InjectModel(Airport.name)
    private readonly airportModel: Model<AirportDocument>,
  ) {}

  // FLT-02: List airports
  async findAll() {
    return this.airportModel
      .find()
      .sort({ name: 1 })
      .lean()
      .exec();
  }
}
