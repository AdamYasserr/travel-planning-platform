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
import { MediaModule } from "../media/media.module";
import { ReferenceDataModule } from "../reference-data/reference-data.module";
import { ItinerariesController } from "./itineraries.controller";
import { ItineraryItemsController } from "./itinerary-items.controller";
import { ItinerariesService } from "./itineraries.service";
import { Itinerary, ItinerarySchema } from "./schemas/itinerary.schema";

@Module({
  imports: [
    FxRatesModule,
    ReferenceDataModule,
    MediaModule,
    MongooseModule.forFeature([
      { name: Itinerary.name, schema: ItinerarySchema },
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: FlightBooking.name, schema: FlightBookingSchema },
    ]),
  ],
  controllers: [ItinerariesController, ItineraryItemsController],
  providers: [ItinerariesService],
  exports: [ItinerariesService],
})
export class ItinerariesModule {}
