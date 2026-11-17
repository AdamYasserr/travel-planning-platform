import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { PageQueryDto } from '../../common/pagination/pagination';
import { CreateReviewDto, UpdateReviewDto } from './dto/reviews.dto';
import { ReviewsService } from './reviews.service';

type AuthenticatedRequest = Request & { user: { userId: string; role?: string } };

@ApiTags('Hotel Reviews')
@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post('hotel-bookings/:id/review')
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Review a Completed hotel stay (booking owner only)',
    description: 'HTL-23. Body { rating: 1-5 whole number, comment?: up to 1000 characters }. One review per reservation (a second is 409); a booking that is not Completed is 409; someone else\'s booking is 404.',
  })
  create(@Param('id') id: string, @Body() dto: CreateReviewDto, @Req() request: AuthenticatedRequest) {
    return this.reviews.create(request.user.userId, id, dto);
  }

  @Patch('reviews/:id')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Edit your review (author only)', description: 'HTL-23. Same rules as creating it. The hotel average is recounted.' })
  update(@Param('id') id: string, @Body() dto: UpdateReviewDto, @Req() request: AuthenticatedRequest) {
    return this.reviews.update(request.user.userId, id, dto);
  }

  @Delete('reviews/:id')
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Delete a review (author or admin)', description: 'HTL-23. The hotel average is recounted; deleting the last review makes the hotel unrated.' })
  remove(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.reviews.remove(request.user, id);
  }

  @Get('hotels/:id/reviews')
  @Public()
  @ApiOperation({
    summary: 'Reviews of a hotel (public)',
    description: 'HTL-24. averageRating, ratingCount and the reviews newest first, 10 per page: rating, comment, author name ("Deleted user" for a deactivated account), dates. Unknown or inactive hotel 404.',
  })
  list(@Param('id') id: string, @Query() query: PageQueryDto) {
    return this.reviews.listForHotel(id, query);
  }
}
