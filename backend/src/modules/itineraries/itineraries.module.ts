import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { FxRatesModule } from "../../integrations/fx-rates/fx-rates.module";
import {
  FlightBooking,
  FlightBookingSchema,
} from "../flight-bookings/schemas/flight-booking.schema";
import {
  HotelBooking,
  HotelBookingSchema,
} from "../hotel-bookings/schemas/hotel-booking.schema";
import { ItinerariesController } from "./itineraries.controller";
import { ItinerariesService } from "./itineraries.service";
import { Itinerary, ItinerarySchema } from "./schemas/itinerary.schema";

@Module({
  imports: [
    FxRatesModule,
    MongooseModule.forFeature([
      { name: Itinerary.name, schema: ItinerarySchema },
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: FlightBooking.name, schema: FlightBookingSchema },
    ]),
  ],
  controllers: [ItinerariesController],
  providers: [ItinerariesService],
  exports: [ItinerariesService],
})
export class ItinerariesModule {}
