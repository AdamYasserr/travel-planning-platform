import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import {
  CreateBudgetEntryDto,
  CreateItineraryActivityDto,
  CreateItineraryDayDto,
  CreateItineraryDto,
  CreateTransportCostDto,
  LinkBookingsDto,
  ItineraryListQueryDto,
  ReorderItineraryDaysDto,
  UpdateBudgetEntryDto,
  UpdateItineraryActivityDto,
  UpdateItineraryDayDto,
  UpdateItineraryDto,
  UpdateTransportCostDto,
} from "./dto/itineraries.dto";
import { ItinerariesService } from "./itineraries.service";

type AuthenticatedRequest = Request & { user: { userId: string } };

@ApiTags("Itineraries")
@ApiCookieAuth("access_token")
@Controller("itineraries")
export class ItinerariesController {
  constructor(private readonly itineraries: ItinerariesService) {}

  @Post()
  @ApiOperation({ summary: "Create a private itinerary" })
  create(@Body() dto: CreateItineraryDto, @Req() req: AuthenticatedRequest) {
    return this.itineraries.create(req.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the signed-in user’s itineraries" })
  list(@Req() req: AuthenticatedRequest, @Query() query: ItineraryListQueryDto) {
    return this.itineraries.list(req.user.userId, query.currency, query.page, query.limit);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Get itinerary details and converted budget totals",
  })
  get(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
    @Query("currency") currency?: string,
  ) {
    return this.itineraries.get(req.user.userId, id, currency);
  }

  @ApiOperation({ summary: "Edit an itinerary" })
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateItineraryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.update(req.user.userId, id, dto);
  }

  @ApiOperation({ summary: "Delete an itinerary" })
  @Delete(":id")
  remove(@Param("id") id: string, @Req() req: AuthenticatedRequest) {
    return this.itineraries.remove(req.user.userId, id);
  }

  @ApiOperation({ summary: "Add a day to an itinerary" })
  @Post(":id/days")
  addDay(
    @Param("id") id: string,
    @Body() dto: CreateItineraryDayDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.addDay(req.user.userId, id, dto);
  }

  @Patch(":id/days/reorder")
  @ApiOperation({ summary: "Reorder the days of an itinerary" })
  reorderDaysMain(
    @Param("id") id: string,
    @Body() dto: ReorderItineraryDaysDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.reorderDays(req.user.userId, id, dto);
  }

  @Patch(":id/days/order")
  @ApiOperation({
    summary: "Reorder the days of an itinerary",
    description: "Legacy alias of PATCH /itineraries/:id/days/reorder.",
  })
  reorderDays(
    @Param("id") id: string,
    @Body() dto: ReorderItineraryDaysDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.reorderDays(req.user.userId, id, dto);
  }

  @ApiOperation({ summary: "Edit a day" })
  @Patch(":id/days/:dayId")
  updateDay(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Body() dto: UpdateItineraryDayDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.updateDay(req.user.userId, id, dayId, dto);
  }

  @ApiOperation({ summary: "Delete a day" })
  @Delete(":id/days/:dayId")
  removeDay(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.removeDay(req.user.userId, id, dayId);
  }

  @ApiOperation({ summary: "Add an activity to a day" })
  @Post(":id/days/:dayId/activities")
  addActivity(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Body() dto: CreateItineraryActivityDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.addActivity(req.user.userId, id, dayId, dto);
  }

  @Patch(":id/days/:dayId/activities/:activityId")
  @ApiOperation({
    summary: "Update an activity",
    description: "Legacy alias of PATCH /activities/:id.",
  })
  updateActivity(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Param("activityId") activityId: string,
    @Body() dto: UpdateItineraryActivityDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.updateActivity(
      req.user.userId,
      id,
      dayId,
      activityId,
      dto,
    );
  }

  @Delete(":id/days/:dayId/activities/:activityId")
  @ApiOperation({
    summary: "Delete an activity",
    description: "Legacy alias of DELETE /activities/:id.",
  })
  removeActivity(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Param("activityId") activityId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.removeActivity(
      req.user.userId,
      id,
      dayId,
      activityId,
    );
  }

  @Post(":id/days/:dayId/budgets")
  @ApiOperation({ summary: "Add a budget entry to a day" })
  addBudget(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Body() dto: CreateBudgetEntryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.addBudgetEntry(req.user.userId, id, dayId, dto);
  }

  @Post(":id/days/:dayId/budget-entries")
  @ApiOperation({
    summary: "Add a budget entry to a day",
    description: "Legacy alias of POST /itineraries/:id/days/:dayId/budgets.",
  })
  addBudgetEntry(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Body() dto: CreateBudgetEntryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.addBudgetEntry(req.user.userId, id, dayId, dto);
  }

  @Patch(":id/days/:dayId/budget-entries/:entryId")
  @ApiOperation({
    summary: "Update a budget entry",
    description: "Legacy alias of PATCH /budgets/:id.",
  })
  updateBudgetEntry(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Param("entryId") entryId: string,
    @Body() dto: UpdateBudgetEntryDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.updateBudgetEntry(
      req.user.userId,
      id,
      dayId,
      entryId,
      dto,
    );
  }

  @Delete(":id/days/:dayId/budget-entries/:entryId")
  @ApiOperation({
    summary: "Delete a budget entry",
    description: "Legacy alias of DELETE /budgets/:id.",
  })
  removeBudgetEntry(
    @Param("id") id: string,
    @Param("dayId") dayId: string,
    @Param("entryId") entryId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.removeBudgetEntry(
      req.user.userId,
      id,
      dayId,
      entryId,
    );
  }

  @ApiOperation({ summary: "Add a transport cost" })
  @Post(":id/transport-costs")
  addTransportCost(
    @Param("id") id: string,
    @Body() dto: CreateTransportCostDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.addTransportCost(req.user.userId, id, dto);
  }

  @Patch(":id/transport-costs/:costId")
  @ApiOperation({
    summary: "Update a transport cost",
    description: "Legacy alias of PATCH /transport-costs/:id.",
  })
  updateTransportCost(
    @Param("id") id: string,
    @Param("costId") costId: string,
    @Body() dto: UpdateTransportCostDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.updateTransportCost(
      req.user.userId,
      id,
      costId,
      dto,
    );
  }

  @Delete(":id/transport-costs/:costId")
  @ApiOperation({
    summary: "Delete a transport cost",
    description: "Legacy alias of DELETE /transport-costs/:id.",
  })
  removeTransportCost(
    @Param("id") id: string,
    @Param("costId") costId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.removeTransportCost(req.user.userId, id, costId);
  }

  @Get(":id/budget-summary")
  @ApiOperation({
    summary: "Get the planned and actual budget totals of an itinerary",
    description: "The same totals as the budgetSummary section of GET /itineraries/:id. Optional `currency` converts the totals.",
  })
  budgetSummary(
    @Param("id") id: string,
    @Req() req: AuthenticatedRequest,
    @Query("currency") currency?: string,
  ) {
    return this.itineraries.budgetSummary(req.user.userId, id, currency);
  }

  @ApiOperation({ summary: "Link existing bookings to an itinerary" })
  @Post(":id/bookings")
  linkBookings(
    @Param("id") id: string,
    @Body() dto: LinkBookingsDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.linkBookings(
      req.user.userId,
      id,
      dto.hotelBookingIds,
      dto.flightBookingIds,
    );
  }

  @ApiOperation({ summary: "Unlink a booking from an itinerary" })
  @Delete(":id/bookings/:bookingId")
  unlinkBooking(
    @Param("id") id: string,
    @Param("bookingId") bookingId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.itineraries.unlinkBooking(req.user.userId, id, bookingId);
  }
}
