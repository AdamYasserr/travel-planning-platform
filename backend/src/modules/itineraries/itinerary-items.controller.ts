import { Body, Controller, Delete, Param, Patch, Req } from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import {
  UpdateBudgetEntryDto,
  UpdateItineraryActivityDto,
  UpdateTransportCostDto,
} from "./dto/itineraries.dto";
import { ItinerariesService } from "./itineraries.service";

type AuthenticatedRequest = Request & { user: { userId: string } };

/**
 * Top-level item routes. Items live inside itineraries, so each id is resolved to the caller's own
 * itinerary first (someone else's id is a 404) and then the same service method as the nested route runs.
 */
@ApiTags("Itineraries")
@ApiCookieAuth("access_token")
@Controller()
export class ItineraryItemsController {
  constructor(private readonly itineraries: ItinerariesService) {}

  @Patch("activities/:id")
  @ApiOperation({
    summary: "Update an activity",
    description: "The nested route PATCH /itineraries/:id/days/:dayId/activities/:activityId is a legacy alias of this route.",
  })
  updateActivity(
    @Param("id") id: string,
    @Body() dto: UpdateItineraryActivityDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.updateActivityById(req.user.userId, id, dto);
  }

  @Delete("activities/:id")
  @ApiOperation({
    summary: "Delete an activity",
    description: "The nested route DELETE /itineraries/:id/days/:dayId/activities/:activityId is a legacy alias of this route.",
  })
  removeActivity(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.itineraries.removeActivityById(req.user.userId, id);
  }

  @Patch("budgets/:id")
  @ApiOperation({
    summary: "Update a budget entry",
    description: "The nested route PATCH /itineraries/:id/days/:dayId/budget-entries/:entryId is a legacy alias of this route.",
  })
  updateBudget(
    @Param("id") id: string,
    @Body() dto: UpdateBudgetEntryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.updateBudgetEntryById(req.user.userId, id, dto);
  }

  @Delete("budgets/:id")
  @ApiOperation({
    summary: "Delete a budget entry",
    description: "The nested route DELETE /itineraries/:id/days/:dayId/budget-entries/:entryId is a legacy alias of this route.",
  })
  removeBudget(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.itineraries.removeBudgetEntryById(req.user.userId, id);
  }

  @Patch("transport-costs/:id")
  @ApiOperation({
    summary: "Update a transport cost",
    description: "The nested route PATCH /itineraries/:id/transport-costs/:costId is a legacy alias of this route.",
  })
  updateTransportCost(
    @Param("id") id: string,
    @Body() dto: UpdateTransportCostDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.updateTransportCostById(req.user.userId, id, dto);
  }

  @Delete("transport-costs/:id")
  @ApiOperation({
    summary: "Delete a transport cost",
    description: "The nested route DELETE /itineraries/:id/transport-costs/:costId is a legacy alias of this route.",
  })
  removeTransportCost(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.itineraries.removeTransportCostById(req.user.userId, id);
  }
}
