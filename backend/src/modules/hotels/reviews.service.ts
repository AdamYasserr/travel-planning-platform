import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Model, Types } from 'mongoose';

import { BOOKING_STATUS } from '../../common/booking/booking-status';
import { runBookingTransaction } from '../../common/booking/booking-transaction';
import { UserRole } from '../../common/enums/user-role.enum';
import { PageQueryDto, paged } from '../../common/pagination/pagination';
import { fieldErrors } from '../../common/pipes/validation.pipe';
import { presentAuthor } from '../../common/users/deleted-user';
import { User } from '../../users/user.schema';
import { HotelBooking } from '../hotel-bookings/schemas/hotel-booking.schema';
import { CreateReviewDto, UpdateReviewDto } from './dto/reviews.dto';
import { HotelsService } from './hotels.service';
import { Hotel } from './schemas/hotel.schema';
import { Review } from './schemas/review.schema';

type Viewer = { userId: string; role?: string };
type ReviewRow = Review & { _id: Types.ObjectId };

/**
 * HTL-23 / HTL-24. Every create, edit and delete runs in ONE transaction with the hotel's rating recount
 * (HotelsService.refreshRating), so the stored average and count always match the visible reviews.
 */
@Injectable()
export class ReviewsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @InjectModel(Review.name) private readonly reviews: Model<Review>,
    @InjectModel(Hotel.name) private readonly hotels: Model<Hotel>,
    @InjectModel(HotelBooking.name) private readonly bookings: Model<HotelBooking>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectConnection() private readonly connection: Connection,
    private readonly hotelsService: HotelsService,
  ) {}

  /** One-off recount at startup (ratings stored before reviews were recounted). Never blocks or fails the boot. */
  async onApplicationBootstrap() {
    try {
      const { rated, reset } = await this.hotelsService.refreshAllRatings();
      this.logger.log(`Hotel ratings recounted: ${rated} rated, ${reset} reset to unrated`);
    } catch (error) {
      this.logger.error(`Hotel rating recount failed: ${(error as Error).message}`);
    }
  }

  /** Owner of a Completed booking only; one review per booking. */
  async create(userId: string, bookingId: string, dto: CreateReviewDto) {
    if (!Types.ObjectId.isValid(bookingId)) throw new BadRequestException('Invalid booking ID');
    const booking = await this.bookings.findOne({ _id: new Types.ObjectId(bookingId), userId: new Types.ObjectId(userId) }).lean().exec();
    if (!booking) throw new NotFoundException('Booking not found');
    if (booking.status !== BOOKING_STATUS.COMPLETED) {
      throw new ConflictException(`Only a Completed stay can be reviewed (this booking is ${booking.status})`);
    }
    try {
      const review = await runBookingTransaction(this.connection, async (session) => {
        const [created] = await this.reviews.create(
          [{ hotelId: booking.hotelId, userId: new Types.ObjectId(userId), bookingId: booking._id, rating: dto.rating, comment: dto.comment ?? '' }],
          { session },
        );
        await this.hotelsService.refreshRating(booking.hotelId, session);
        return created.toObject() as ReviewRow;
      });
      return this.view(review);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ConflictException('This booking has already been reviewed');
      throw error;
    }
  }

  /** The author only (anyone else 404). */
  async update(userId: string, reviewId: string, dto: UpdateReviewDto) {
    if (dto.rating === undefined && dto.comment === undefined) {
      throw fieldErrors([{ field: 'rating', messages: ['send rating and/or comment'] }]);
    }
    const existing = await this.findReview(reviewId);
    if (String(existing.userId) !== userId) throw new NotFoundException('Review not found');
    const review = await runBookingTransaction(this.connection, async (session) => {
      const updated = await this.reviews
        .findOneAndUpdate(
          { _id: existing._id, userId: existing.userId },
          { $set: { ...(dto.rating !== undefined ? { rating: dto.rating } : {}), ...(dto.comment !== undefined ? { comment: dto.comment } : {}) } },
          { returnDocument: 'after', runValidators: true, session },
        )
        .lean<ReviewRow>()
        .exec();
      if (!updated) throw new NotFoundException('Review not found');
      await this.hotelsService.refreshRating(updated.hotelId, session);
      return updated;
    });
    return this.view(review);
  }

  /** The author or an admin (anyone else 404). A hard delete; the hotel's rating is recounted. */
  async remove(viewer: Viewer, reviewId: string) {
    const existing = await this.findReview(reviewId);
    if (viewer.role !== UserRole.ADMIN && String(existing.userId) !== viewer.userId) throw new NotFoundException('Review not found');
    await runBookingTransaction(this.connection, async (session) => {
      const deleted = await this.reviews.findOneAndDelete({ _id: existing._id }, { session }).exec();
      if (!deleted) throw new NotFoundException('Review not found');
      await this.hotelsService.refreshRating(existing.hotelId, session);
    });
    return { id: String(existing._id), deleted: true };
  }

  /** HTL-24: public. Unknown or inactive hotel 404. Hidden reviews are neither listed nor counted. */
  async listForHotel(hotelId: string, query: PageQueryDto) {
    if (!Types.ObjectId.isValid(hotelId)) throw new BadRequestException('Invalid hotel ID');
    const hotel = await this.hotels.findOne({ _id: new Types.ObjectId(hotelId), isActive: true }).select('averageRating ratingCount').lean().exec();
    if (!hotel) throw new NotFoundException('Hotel not found');
    const filter = { hotelId: hotel._id, isHidden: { $ne: true } };
    const [rows, total] = await Promise.all([
      this.reviews.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean<ReviewRow[]>().exec(),
      this.reviews.countDocuments(filter).exec(),
    ]);
    const authors = rows.length
      ? await this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).select('_id name isActive deactivatedAt').lean().exec()
      : [];
    const authorById = new Map(authors.map((a) => [String(a._id), a]));
    const items = rows.map((r) => ({
      id: String(r._id),
      rating: r.rating,
      comment: r.comment,
      author: { name: presentAuthor(authorById.get(String(r.userId)) as never).name },
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    return { averageRating: hotel.averageRating ?? null, ratingCount: hotel.ratingCount ?? 0, ...paged(items, total, query.page, query.limit) };
  }

  private async findReview(reviewId: string) {
    if (!Types.ObjectId.isValid(reviewId)) throw new BadRequestException('Invalid review ID');
    const review = await this.reviews.findById(reviewId).lean<ReviewRow>().exec();
    if (!review) throw new NotFoundException('Review not found');
    return review;
  }

  private view(r: ReviewRow) {
    return {
      id: String(r._id),
      hotelId: String(r.hotelId),
      bookingId: String(r.bookingId),
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
