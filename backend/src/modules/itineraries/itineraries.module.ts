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
import { FlightsModule } from "../flights/flights.module";
import { HotelsModule } from "../hotels/hotels.module";
import { MediaModule } from "../media/media.module";
import { ReferenceDataModule } from "../reference-data/reference-data.module";
import { User, UserSchema } from "../../users/user.schema";
import { ItinerariesController } from "./itineraries.controller";
import { ItinerarySearchController } from "./itinerary-search.controller";
import { ItinerarySearchService } from "./itinerary-search.service";
import { ItineraryCloneController } from "./itinerary-clone.controller";
import { PublicItinerariesController } from "./public-itineraries.controller";
import { PublicItinerariesService } from "./public-itineraries.service";
import { ItineraryItemsController } from "./itinerary-items.controller";
import { ItinerariesService } from "./itineraries.service";
import { Itinerary, ItinerarySchema } from "./schemas/itinerary.schema";

@Module({
  imports: [
    FxRatesModule,
    ReferenceDataModule,
    MediaModule,
    HotelsModule,
    FlightsModule,
    MongooseModule.forFeature([
      { name: Itinerary.name, schema: ItinerarySchema },
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: FlightBooking.name, schema: FlightBookingSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  // The public controller comes first so `itineraries/public/...` is never matched by `itineraries/:id`.
  controllers: [PublicItinerariesController, ItinerariesController, ItineraryItemsController, ItineraryCloneController, ItinerarySearchController],
  providers: [ItinerariesService, PublicItinerariesService, ItinerarySearchService],
  exports: [ItinerariesService],
})
export class ItinerariesModule {}
