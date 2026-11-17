import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

import { User, UserDocument } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { CreateModeratorDto, AdminAccountQueryDto, AdminBookingQueryDto, AdminProviderType, ModeratorProviderType } from './dto/administration.dto';
import { Airline } from '../airlines/schemas/airline.schema';
import { Hotel } from '../hotels/schemas/hotel.schema';
import { FlightBooking } from '../flight-bookings/schemas/flight-booking.schema';
import { HotelBooking } from '../hotel-bookings/schemas/hotel-booking.schema';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Flight } from '../flights/schemas/flight.schema';
import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';
import { HotelBookingStatus } from '../hotel-bookings/schemas/hotel-booking.schema';

@Injectable()
export class AdministrationService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Airline.name) private readonly airlineModel: Model<Airline>,
    @InjectModel(Hotel.name) private readonly hotelModel: Model<Hotel>,
    @InjectModel(FlightBooking.name) private readonly flightBookings: Model<FlightBooking>,
    @InjectModel(HotelBooking.name) private readonly hotelBookings: Model<HotelBooking>,
    private readonly auditLogs: AuditLogsService,
    private readonly notifications: NotificationsService,
    @InjectModel(Flight.name) private readonly flights: Model<Flight>,
  ) {}

  async createModerator(actorId: string, dto: CreateModeratorDto) {
    const providerType = dto.providerType as unknown as AdminProviderType;
    const provider = await this.getProvider(providerType, dto.providerId);
    if (!provider.isActive) throw new ConflictException('Cannot assign a moderator to an inactive provider');
    const email = dto.email.trim().toLowerCase();
    if (await this.userModel.exists({ email })) throw new ConflictException('Email is already registered');

    // Admin-created moderator accounts receive a random, undisclosed password and must use reset flow.
    const password = await bcrypt.hash(randomBytes(32).toString('hex'), 12);
    const userData: Partial<User> = {
      name: dto.name.trim(), email, password, role: UserRole.MODERATOR,
      isActive: true, isSuspended: false, mustChangePassword: true,
      lastActivityAt: new Date(),
      ...(dto.providerType === ModeratorProviderType.AIRLINE ? { airlineId: dto.providerId, hotelId: null } : { hotelId: dto.providerId, airlineId: null }),
    };
    let moderator: UserDocument;
    try {
      moderator = await this.userModel.create(userData);
    } catch (error: unknown) {
      if (isDuplicateKey(error)) throw new ConflictException('Email is already registered');
      throw error;
    }
    await this.auditLogs.record(actorId, 'moderator.created', 'user', moderator._id.toString(), { providerType: dto.providerType, providerId: dto.providerId });
    return { message: 'Moderator account created', account: this.publicAccount(moderator) };
  }

  async listAccounts(query: AdminAccountQueryDto) {
    const page = query.page ?? 1; const limit = query.limit ?? 20;
    const filter: Record<string, unknown> = {};
    if (query.role) filter.role = query.role;
    if (query.search?.trim()) {
      const safeSearch = escapeRegex(query.search.trim());
      filter.$or = [{ name: { $regex: safeSearch, $options: 'i' } }, { email: { $regex: safeSearch, $options: 'i' } }];
    }
    const [items, total] = await Promise.all([
      this.userModel.find(filter).select('-password -refreshTokenHash').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total, pages: Math.ceil(total / limit) };
  }

  async getAccount(id: string) {
    this.assertObjectId(id, 'account');
    const account = await this.userModel.findById(id).select('-password -refreshTokenHash').lean().exec();
    if (!account) throw new NotFoundException('Account not found');
    return account;
  }

  async setAccountSuspended(actorId: string, id: string, suspended: boolean) {
    this.assertObjectId(id, 'account');
    const account = await this.userModel.findById(id).exec();
    if (!account) throw new NotFoundException('Account not found');
    if (account.role === UserRole.ADMIN) throw new BadRequestException('Administrator accounts cannot be managed here');
    if (account.isSuspended === suspended) throw new ConflictException(suspended ? 'Account is already suspended' : 'Account is not suspended');
    account.isSuspended = suspended;
    account.refreshTokenHash = null;
    account.failedLoginAttempts = 0;
    account.lockUntil = null;
    await account.save();
    await this.auditLogs.record(actorId, suspended ? 'account.suspended' : 'account.reactivated', 'user', id);
    return { message: suspended ? 'Account suspended' : 'Account reactivated', account: this.publicAccount(account) };
  }

  async setProviderActive(actorId: string, type: AdminProviderType, id: string, active: boolean) {
    this.assertObjectId(id, 'provider');
    const provider = type === AdminProviderType.AIRLINE
      ? await this.airlineModel.findById(id).exec()
      : await this.hotelModel.findById(id).exec();
    if (!provider) throw new NotFoundException('Provider not found');
    if (provider.isActive === active) throw new ConflictException(active ? 'Provider is already active' : 'Provider is already inactive');
    const affectedUsers = !active ? await this.findAffectedUsers(type, id) : [];
    provider.isActive = active;
    await provider.save();
    await this.auditLogs.record(actorId, active ? 'provider.reactivated' : 'provider.deactivated', type, id);
    if (!active && affectedUsers.length) {
      await this.notifications.createForUsers(affectedUsers, {
        title: 'Travel provider unavailable',
        message: 'A travel provider for one of your upcoming bookings is no longer accepting new bookings. Your existing reservation remains on file. Please review its details.',
        resourceType: type,
        resourceId: id,
      });
    }
    return { message: active ? 'Provider reactivated' : 'Provider deactivated', provider: { id: provider._id.toString(), isActive: provider.isActive } };
  }

  async listBookings(query: AdminBookingQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const types: Array<'flight' | 'hotel'> = query.type ? [query.type] : ['flight', 'hotel'];
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    const [flightItems, flightTotal, hotelItems, hotelTotal] = await Promise.all([
      types.includes('flight') ? this.flightBookings.find(filter).sort({ createdAt: -1, _id: -1 }).lean().exec() : [],
      types.includes('flight') ? this.flightBookings.countDocuments(filter).exec() : 0,
      types.includes('hotel') ? this.hotelBookings.find(filter).sort({ createdAt: -1, _id: -1 }).lean().exec() : [],
      types.includes('hotel') ? this.hotelBookings.countDocuments(filter).exec() : 0,
    ]);
    const sorted = [
      ...flightItems.map((booking) => ({ type: 'flight' as const, ...booking })),
      ...hotelItems.map((booking) => ({ type: 'hotel' as const, ...booking })),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const total = flightTotal + hotelTotal;
    return { items: sorted.slice((page - 1) * limit, page * limit), page, limit, total, pages: Math.ceil(total / limit), countsByType: { flight: flightTotal, hotel: hotelTotal } };
  }

  async resetUserPassword(actorId: string, userId: string) {
    this.assertObjectId(userId, 'account');
    const user = await this.userModel.findById(userId);
    if (!user) throw new NotFoundException('Account not found');
    if (user.role !== UserRole.USER && user.role !== UserRole.MODERATOR) {
      throw new BadRequestException('Only registered user and moderator passwords can be reset');
    }
    const temporaryPassword = `Temp-${randomBytes(8).toString('hex')}-7`;
    user.password = await bcrypt.hash(temporaryPassword, 12);
    user.mustChangePassword = true;
    user.refreshTokenHash = null;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();
    await this.auditLogs.record(actorId, 'account.password_reset', 'user', userId);
    // Source security wording is unavailable in this checkout; existing one-time response behavior retained.
    return { message: 'Password reset successfully', user: this.publicAccount(user), temporaryPassword, mustChangePassword: true };
  }


  private async findAffectedUsers(type: AdminProviderType, id: string): Promise<string[]> {
    const now = new Date();
    if (type === AdminProviderType.HOTEL) {
      const bookings = await this.hotelBookings.find({
        hotelId: new Types.ObjectId(id),
        checkOutDate: { $gt: now },
        status: { $in: [HotelBookingStatus.CONFIRMED, HotelBookingStatus.PENDING_PAYMENT] },
      }).select('userId').lean().exec();
      return [...new Set(bookings.map((booking) => booking.userId.toString()))];
    }
    const matchingFlights = await this.flights.find({ airlineId: new Types.ObjectId(id), departureTime: { $gt: now } }).select('_id').lean().exec();
    const flightIds = matchingFlights.map((flight) => flight._id);
    if (!flightIds.length) return [];
    const bookings = await this.flightBookings.find({
      flightId: { $in: flightIds },
      status: { $in: [FlightBookingStatus.CONFIRMED, FlightBookingStatus.PENDING_PAYMENT] },
    }).select('userId').lean().exec();
    return [...new Set(bookings.map((booking) => booking.userId.toString()))];
  }

  private async getProvider(type: AdminProviderType, id: string) {
    this.assertObjectId(id, 'provider');
    const provider = type === AdminProviderType.AIRLINE
      ? await this.airlineModel.findById(id).exec()
      : await this.hotelModel.findById(id).exec();
    if (!provider) throw new NotFoundException('Provider not found');
    return provider;
  }

  private assertObjectId(id: string, label: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid ${label} ID`);
  }

  private publicAccount(user: any) {
    return { id: user._id.toString(), name: user.name, email: user.email, role: user.role, isActive: user.isActive, isSuspended: user.isSuspended, mustChangePassword: user.mustChangePassword, airlineId: user.airlineId ?? null, hotelId: user.hotelId ?? null, createdAt: user.createdAt };
  }
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
