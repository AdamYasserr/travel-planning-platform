import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { PublicItinerarySearchQueryDto } from "./dto/public-itineraries.dto";
import { PublicItinerariesService } from "./public-itineraries.service";

/**
 * ITN-20 / ITN-21. No authentication. Registered before the :id routes of ItinerariesController so that
 * `public` is never read as an itinerary id.
 */
@ApiTags("Itineraries")
@Public()
@Controller("itineraries/public")
export class PublicItinerariesController {
  constructor(private readonly publicItineraries: PublicItinerariesService) {}

  @Get("search")
  @ApiOperation({
    summary: "Search public itineraries",
    description:
      "No sign-in needed. Only public itineraries are listed, newest first, 10 per page (`limit` up to 100). Filters: `city` (a city_id with a day in it), `country` (a country code), `from` / `to` (YYYY-MM-DD: the itinerary overlaps the range). Each item has the title, countries, dates, day count, cities and the author's name only.",
  })
  @ApiResponse({ status: 200, description: "{ items, page, limit, total, pages }" })
  @ApiResponse({ status: 400, description: "A filter is malformed (the error names the field)." })
  search(@Query() query: PublicItinerarySearchQueryDto) {
    return this.publicItineraries.search(query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get a public itinerary",
    description:
      "No sign-in needed. Days (derived date, city, notes), activities (name, description, time, images) and city groups. Never budgets, transport costs, bookings, payments or the owner's id or e-mail. A private, hidden or unknown itinerary is 404.",
  })
  @ApiParam({ name: "id", example: "507f1f77bcf86cd799439011" })
  @ApiResponse({ status: 404, description: "Not found, or not public." })
  detail(@Param("id") id: string) {
    return this.publicItineraries.detail(id);
  }
}
