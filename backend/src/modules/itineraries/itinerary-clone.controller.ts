import { Body, Controller, Param, Post, Req } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { CloneItineraryDto } from "./dto/public-itineraries.dto";
import { PublicItinerariesService } from "./public-itineraries.service";

type AuthenticatedRequest = Request & { user: { userId: string } };

@ApiTags("Itineraries")
@ApiCookieAuth("access_token")
@Controller("itineraries")
export class ItineraryCloneController {
  constructor(private readonly publicItineraries: PublicItinerariesService) {}

  @Post(":id/clone")
  @ApiOperation({
    summary: "Clone a public itinerary into your account",
    description:
      "ITN-21. Creates a new PRIVATE itinerary owned by the caller with `clonedFrom: { itineraryId, authorName }`. Copies the title, countries, days, notes, activity name / description / time, planned budget entries and transport costs. Never copies images, activity costs, actual spending, booking links or payments. The optional body `startDate` moves the whole clone (day dates are derived). The source must be public or your own; otherwise 404.",
  })
  @ApiParam({ name: "id", example: "507f1f77bcf86cd799439011" })
  @ApiResponse({ status: 201, description: "The new private itinerary (same view as GET /itineraries/:id)." })
  @ApiResponse({ status: 404, description: "Not found, or someone else's private itinerary." })
  clone(@Param("id") id: string, @Body() dto: CloneItineraryDto, @Req() req: AuthenticatedRequest) {
    return this.publicItineraries.clone(req.user.userId, id, dto);
  }
}
