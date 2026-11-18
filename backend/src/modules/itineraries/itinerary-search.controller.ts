import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { ItineraryFlightSearchQueryDto, ItineraryHotelSearchQueryDto } from "./dto/itinerary-search.dto";
import { ItinerarySearchService } from "./itinerary-search.service";

type AuthenticatedRequest = Request & { user: { userId: string } };

@ApiTags("Itineraries")
@ApiCookieAuth("access_token")
@Controller("itineraries")
export class ItinerarySearchController {
  constructor(private readonly search: ItinerarySearchService) {}

  @Get(":id/hotels")
  @ApiOperation({
    summary: "Search hotels for a city group of your itinerary",
    description:
      "ITN-25. The same search and result as GET /hotels/search, with the city and the stay taken from the itinerary: the city of the chosen city group (`group` number, or `city`; default the first group), check-in on its first day and check-out the day after its last day. `checkIn` / `checkOut` may narrow the stay inside that span. Owner only; anyone else gets 404.",
  })
  @ApiParam({ name: "id", example: "507f1f77bcf86cd799439011" })
  @ApiResponse({ status: 200, description: "{ itineraryId, context, items, page, limit, total, pages }" })
  @ApiResponse({ status: 400, description: "No such city group, a stay outside the group, or a bad hotel filter (the error names the field)." })
  @ApiResponse({ status: 404, description: "Itinerary not found (or not yours)." })
  hotels(@Param("id") id: string, @Query() query: ItineraryHotelSearchQueryDto, @Req() req: AuthenticatedRequest) {
    return this.search.hotels(req.user.userId, id, query);
  }

  @Get(":id/flights")
  @ApiOperation({
    summary: "Search flights into a city group of your itinerary",
    description:
      "ITN-26. The same search and result as the outbound part of GET /flights/search, from every airport of `fromCity` (default: the city of the previous group) to every airport of the chosen group's city, on `date` (default the group's first day; at most one day earlier). Owner only; anyone else gets 404.",
  })
  @ApiParam({ name: "id", example: "507f1f77bcf86cd799439011" })
  @ApiResponse({ status: 200, description: "{ itineraryId, context, items, page, limit, total, pages }" })
  @ApiResponse({ status: 400, description: "No such city group, no origin city, a date outside the allowed window, or a bad flight filter." })
  @ApiResponse({ status: 404, description: "Itinerary not found (or not yours)." })
  flights(@Param("id") id: string, @Query() query: ItineraryFlightSearchQueryDto, @Req() req: AuthenticatedRequest) {
    return this.search.flights(req.user.userId, id, query);
  }
}
