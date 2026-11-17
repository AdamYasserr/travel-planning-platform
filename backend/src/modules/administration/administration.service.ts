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
import { CreateModeratorDto, AdminAccountQueryDto, AdminAccountStatus, AdminBookingDateField, AdminBookingQueryDto, AdminProviderType, ModeratorProviderType } from './dto/administration.dto';
import { Airline } from '../airlines/schemas/airline.schema';
import { Hotel } from '../hotels/schemas/hotel.schema';
import { FlightBooking } from '../flight-bookings/schemas/flight-booking.schema';
import { HotelBooking } from '../hotel-bookings/schemas/hotel-booking.schema';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
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

  /** ACC-14: accounts with search (name/email), role AND status filters, page size 10. */
  async listAccounts(query: AdminAccountQueryDto) {
    const page = query.page ?? 1; const limit = query.limit ?? 10;
    const clauses: Record<string, unknown>[] = [];
    if (query.role) clauses.push({ role: query.role });
    if (query.status === AdminAccountStatus.DEACTIVATED) clauses.push({ $or: [{ isActive: false }, { deactivatedAt: { $ne: null } }] });
    if (query.status === AdminAccountStatus.SUSPENDED) clauses.push({ isActive: { $ne: false }, deactivatedAt: null, isSuspended: true });
    if (query.status === AdminAccountStatus.ACTIVE) clauses.push({ isActive: { $ne: false }, deactivatedAt: null, isSuspended: { $ne: true } });
    if (query.search?.trim()) {
      const safeSearch = escapeRegex(query.search.trim());
      clauses.push({ $or: [{ name: { $regex: safeSearch, $options: 'i' } }, { email: { $regex: safeSearch, $options: 'i' } }] });
    }
    const filter = clauses.length ? { $and: clauses } : {};
    const [rows, total] = await Promise.all([
      this.userModel.find(filter).select('name email role isActive isSuspended deactivatedAt createdAt').sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    const items = rows.map((user: any) => ({
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      status: accountStatus(user),
      registeredAt: user.createdAt,
    }));
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
    await this.notifications.notify(id, suspended ? NotificationType.ACCOUNT_SUSPENDED : NotificationType.ACCOUNT_REACTIVATED, { accountId: id });
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
      await this.notifications.notifyMany(affectedUsers, NotificationType.PROVIDER_SUSPENDED, { providerType: type, providerId: id });
    }
    return { message: active ? 'Provider reactivated' : 'Provider deactivated', provider: { id: provider._id.toString(), isActive: provider.isActive } };
  }

  /**
   * ACC-17: bookings platform-wide. Filters: type, status, user, and a from/to date range applied to the
   * travel start date (check-in / departure, default) or the booking creation date (dateField=booked).
   */
  async listBookings(query: AdminBookingQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const types: Array<'flight' | 'hotel'> = query.type ? [query.type] : ['flight', 'hotel'];
    const base: Record<string, unknown> = {};
    if (query.status) base.status = query.status;
    if (query.userId) base.userId = new Types.ObjectId(query.userId);
    const range = this.dateRange(query.from, query.to);
    const booked = query.dateField === AdminBookingDateField.BOOKED;
    const hotelFilter = { ...base, ...(range ? { [booked ? 'createdAt' : 'checkInDate']: range } : {}) };
    const flightFilter = { ...base, ...(range ? { [booked ? 'createdAt' : 'departureTime']: range } : {}) };
    const fetchCount = page * limit;
    const wantFlights = types.includes('flight');
    const wantHotels = types.includes('hotel');

    const [flightRows, flightTotal, hotelRows, hotelTotal] = await Promise.all([
      wantFlights ? this.flightBookings.find(flightFilter).sort({ createdAt: -1, _id: -1 }).limit(fetchCount).lean().exec() : [],
      wantFlights ? this.flightBookings.countDocuments(flightFilter).exec() : 0,
      wantHotels ? this.hotelBookings.find(hotelFilter).sort({ createdAt: -1, _id: -1 }).limit(fetchCount).lean().exec() : [],
      wantHotels ? this.hotelBookings.countDocuments(hotelFilter).exec() : 0,
    ]);

    const merged = [
      ...(flightRows as any[]).map((row) => ({ kind: 'flight' as const, row })),
      ...(hotelRows as any[]).map((row) => ({ kind: 'hotel' as const, row })),
    ]
      .sort((a, b) => new Date(b.row.createdAt).getTime() - new Date(a.row.createdAt).getTime())
      .slice((page - 1) * limit, page * limit);

    const pageFlights = merged.filter((m) => m.kind === 'flight').map((m) => m.row);
    const pageHotels = merged.filter((m) => m.kind === 'hotel').map((m) => m.row);
    const [users, hotels, flights] = await Promise.all([
      this.userModel.find({ _id: { $in: merged.map((m) => m.row.userId) } }).select('name email').lean().exec(),
      pageHotels.length ? this.hotelModel.find({ _id: { $in: pageHotels.map((b) => b.hotelId) } }).select('name').lean().exec() : [],
      pageFlights.length ? this.flights.find({ _id: { $in: pageFlights.map((b) => b.flightId) } }).select('airlineId flightNumber').lean().exec() : [],
    ]);
    const airlines = flights.length ? await this.airlineModel.find({ _id: { $in: flights.map((f: any) => f.airlineId) } }).select('name').lean().exec() : [];
    const byId = <T extends { _id: unknown }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));
    const userMap = byId(users as any[]);
    const hotelMap = byId(hotels as any[]);
    const flightMap = byId(flights as any[]);
    const airlineMap = byId(airlines as any[]);

    const items = merged.map(({ kind, row }) => {
      const user: any = userMap.get(String(row.userId));
      const common = {
        id: String(row._id),
        type: kind,
        reference: row.reference,
        user: user ? { id: String(user._id), name: user.name, email: user.email } : { id: String(row.userId), name: null, email: null },
        amount: { total: row.totalPrice, currency: row.currency },
        status: row.status,
        bookedAt: row.createdAt,
      };
      if (kind === 'hotel') {
        const hotel: any = hotelMap.get(String(row.hotelId));
        return { ...common, provider: { id: String(row.hotelId), name: hotel?.name ?? null }, dates: { checkIn: row.checkInDate, checkOut: row.checkOutDate } };
      }
      const flight: any = flightMap.get(String(row.flightId));
      const airline: any = flight ? airlineMap.get(String(flight.airlineId)) : undefined;
      return { ...common, provider: { id: flight ? String(flight.airlineId) : null, name: airline?.name ?? null, flightNumber: flight?.flightNumber ?? null }, dates: { departure: row.departureTime } };
    });

    const total = flightTotal + hotelTotal;
    return { items, page, limit, total, pages: Math.ceil(total / limit), countsByType: { flight: flightTotal, hotel: hotelTotal } };
  }

  private dateRange(from?: string, to?: string) {
    if (!from && !to) return null;
    const start = from ? new Date(`${from}T00:00:00.000Z`) : null;
    const endExclusive = to ? new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) : null;
    if ((start && Number.isNaN(start.getTime())) || (endExclusive && Number.isNaN(endExclusive.getTime()))) {
      throw new BadRequestException('Invalid date range');
    }
    if (start && endExclusive && start.getTime() >= endExclusive.getTime()) {
      throw new BadRequestException('from must not be after to');
    }
    return { ...(start ? { $gte: start } : {}), ...(endExclusive ? { $lt: endExclusive } : {}) };
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

function accountStatus(user: { isActive?: boolean; deactivatedAt?: Date | null; isSuspended?: boolean }): AdminAccountStatus {
  if (user.isActive === false || user.deactivatedAt) return AdminAccountStatus.DEACTIVATED;
  return user.isSuspended ? AdminAccountStatus.SUSPENDED : AdminAccountStatus.ACTIVE;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
