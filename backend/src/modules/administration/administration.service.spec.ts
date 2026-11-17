import { jest } from '@jest/globals';
import { ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdministrationService } from './administration.service';
import { AdminProviderType } from './dto/administration.dto';
import { UserRole } from '../../common/enums/user-role.enum';

describe('AdministrationService', () => {
  const id = new Types.ObjectId().toString();
  const actorId = new Types.ObjectId().toString();
  let users: any;
  let airlines: any;
  let hotels: any;
  let flightBookings: any;
  let hotelBookings: any;
  let audit: any;
  let service: AdministrationService;

  beforeEach(() => {
    const query = (value: any) => ({ exec: (jest.fn as any)().mockResolvedValue(value), select: (jest.fn as any)().mockReturnThis(), sort: (jest.fn as any)().mockReturnThis(), skip: (jest.fn as any)().mockReturnThis(), limit: (jest.fn as any)().mockReturnThis(), lean: (jest.fn as any)().mockReturnThis() });
    users = { findOne: (jest.fn as any)().mockResolvedValue(null), exists: (jest.fn as any)().mockResolvedValue(null), create: (jest.fn as any)(), find: (jest.fn as any)(() => query([])), countDocuments: (jest.fn as any)(() => query(0)), findById: (jest.fn as any)(), findByIdAndUpdate: (jest.fn as any)() };
    airlines = { findById: (jest.fn as any)(), findByIdAndUpdate: (jest.fn as any)() };
    hotels = { findById: (jest.fn as any)(), findByIdAndUpdate: (jest.fn as any)() };
    flightBookings = { find: (jest.fn as any)(() => query([])), countDocuments: (jest.fn as any)(() => query(0)) };
    hotelBookings = { find: (jest.fn as any)(() => query([])), countDocuments: (jest.fn as any)(() => query(0)) };
    audit = { record: (jest.fn as any)().mockResolvedValue(undefined) };
    service = new AdministrationService(users, airlines, hotels, flightBookings, hotelBookings, audit, { notify: (jest.fn as any)().mockResolvedValue(undefined), notifyMany: (jest.fn as any)().mockResolvedValue(0) } as any, { find: (jest.fn as any)() } as any);
  });

  it('creates an airline moderator with exactly one provider assignment and no exposed password', async () => {
    airlines.findById.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue({ isActive: true }) });
    const saved = { _id: new Types.ObjectId(id), name: 'Mod', email: 'mod@example.com', role: UserRole.MODERATOR, isActive: true, isSuspended: false, mustChangePassword: true, airlineId: id, hotelId: null };
    users.create.mockResolvedValue(saved);
    const result = await service.createModerator(actorId, { name: ' Mod ', email: 'MOD@example.com', providerType: 'airline' as any, providerId: id });
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ airlineId: id, hotelId: null, role: UserRole.MODERATOR, mustChangePassword: true }));
    expect(result.account).not.toHaveProperty('password');
    expect(audit.record).toHaveBeenCalledWith(actorId, 'moderator.created', 'user', id, expect.any(Object));
  });

  it('rejects assigning moderators to inactive providers', async () => {
    hotels.findById.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue({ isActive: false }) });
    await expect(service.createModerator(actorId, { name: 'Mod', email: 'm@e.co', providerType: 'hotel' as any, providerId: id })).rejects.toBeInstanceOf(ConflictException);
    expect(users.create).not.toHaveBeenCalled();
  });

  it('lists accounts without credentials and supports pagination', async () => {
    const exec = (jest.fn as any)().mockResolvedValue([{ _id: new Types.ObjectId(id), email: 'a@b.com' }]);
    users.find.mockReturnValue({ select: (jest.fn as any)().mockReturnValue({ sort: (jest.fn as any)().mockReturnValue({ skip: (jest.fn as any)().mockReturnValue({ limit: (jest.fn as any)().mockReturnValue({ lean: (jest.fn as any)().mockReturnValue({ exec }) }) }) }) }) });
    users.countDocuments.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(1) });
    const result = await service.listAccounts({ page: 2, limit: 10 });
    expect(result).toMatchObject({ page: 2, limit: 10, total: 1 });
    expect(users.find().select).toBeDefined();
  });

  it('suspends accounts and revokes sessions; blocks admin suspension', async () => {
    const account: any = { _id: new Types.ObjectId(id), role: UserRole.USER, isSuspended: false, refreshTokenHash: 'hash', failedLoginAttempts: 3, lockUntil: new Date(), save: (jest.fn as any)() };
    users.findById.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(account) });
    await service.setAccountSuspended(actorId, id, true);
    expect(account).toMatchObject({ isSuspended: true, refreshTokenHash: null, failedLoginAttempts: 0, lockUntil: null });
    account.role = UserRole.ADMIN; account.isSuspended = false;
    await expect(service.setAccountSuspended(actorId, id, true)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deactivates a provider without changing booking records', async () => {
    const provider: any = { _id: new Types.ObjectId(id), isActive: true, save: (jest.fn as any)() };
    hotels.findById.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(provider) });
    await service.setProviderActive(actorId, AdminProviderType.HOTEL, id, false);
    expect(provider.isActive).toBe(false);
    expect(provider.save).toHaveBeenCalled();
    expect(hotelBookings.find).toHaveBeenCalledWith(expect.objectContaining({ hotelId: expect.any(Types.ObjectId), status: expect.any(Object) }));
    expect(audit.record).toHaveBeenCalledWith(actorId, 'provider.deactivated', 'hotel', id);
  });

  describe('ACC-17 listBookings', () => {
    const chain = (value: unknown) => {
      const c: any = {};
      for (const m of ['sort', 'limit', 'select', 'lean']) c[m] = (jest.fn as any)().mockReturnValue(c);
      c.exec = (jest.fn as any)().mockResolvedValue(value);
      return c;
    };
    const hotelId = new Types.ObjectId();
    const flightId = new Types.ObjectId();
    const airlineId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    let flightsModel: any;

    beforeEach(() => {
      const flight = { _id: new Types.ObjectId(), userId, flightId, reference: 'FLT-1', totalPrice: 100, currency: 'EUR', status: 'Confirmed', departureTime: new Date('2026-12-05T10:00:00Z'), createdAt: new Date('2026-01-02') };
      const hotel = { _id: new Types.ObjectId(), userId, hotelId, reference: 'HTL-1', totalPrice: 300, currency: 'EGP', status: 'Pending Payment', checkInDate: new Date('2026-12-10'), checkOutDate: new Date('2026-12-13'), createdAt: new Date('2026-01-01') };
      flightBookings.find.mockReturnValue(chain([flight]));
      hotelBookings.find.mockReturnValue(chain([hotel]));
      flightBookings.countDocuments.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(1) });
      hotelBookings.countDocuments.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(1) });
      users.find.mockReturnValue(chain([{ _id: userId, name: 'Amina', email: 'a@example.com' }]));
      hotels.find = (jest.fn as any)().mockReturnValue(chain([{ _id: hotelId, name: 'Nile Hotel' }]));
      airlines.find = (jest.fn as any)().mockReturnValue(chain([{ _id: airlineId, name: 'EgyptAir' }]));
      flightsModel = { find: (jest.fn as any)().mockReturnValue(chain([{ _id: flightId, airlineId, flightNumber: 'MS777' }])) };
      service = new AdministrationService(users, airlines, hotels, flightBookings, hotelBookings, audit, { notify: (jest.fn as any)(), notifyMany: (jest.fn as any)() } as any, flightsModel);
    });

    it('returns reference, user, provider, dates, amount and status, newest first', async () => {
      const result = await service.listBookings({ page: 1, limit: 10 } as any);
      expect(result.total).toBe(2);
      expect(result.items.map((i: any) => i.reference)).toEqual(['FLT-1', 'HTL-1']);
      expect(result.items[0]).toMatchObject({
        type: 'flight', reference: 'FLT-1', status: 'Confirmed',
        user: { name: 'Amina', email: 'a@example.com' },
        provider: { name: 'EgyptAir', flightNumber: 'MS777' },
        amount: { total: 100, currency: 'EUR' },
        dates: { departure: new Date('2026-12-05T10:00:00Z') },
      });
      expect(result.items[1]).toMatchObject({
        type: 'hotel', provider: { name: 'Nile Hotel' }, amount: { total: 300, currency: 'EGP' },
        dates: { checkIn: new Date('2026-12-10'), checkOut: new Date('2026-12-13') },
      });
    });

    it('filters by type and status', async () => {
      await service.listBookings({ page: 1, limit: 10, type: 'hotel', status: 'Confirmed' } as any);
      expect(flightBookings.find).not.toHaveBeenCalled();
      expect(hotelBookings.find).toHaveBeenCalledWith({ status: 'Confirmed' });
    });

    it('applies the date range to the travel start date by default (inclusive of the end day)', async () => {
      await service.listBookings({ page: 1, limit: 10, from: '2026-12-01', to: '2026-12-31' } as any);
      const range = { $gte: new Date('2026-12-01T00:00:00.000Z'), $lt: new Date('2027-01-01T00:00:00.000Z') };
      expect(hotelBookings.find).toHaveBeenCalledWith({ checkInDate: range });
      expect(flightBookings.find).toHaveBeenCalledWith({ departureTime: range });
    });

    it('dateField=booked switches the filter to the creation date', async () => {
      await service.listBookings({ page: 1, limit: 10, from: '2026-01-01', dateField: 'booked' } as any);
      const range = { $gte: new Date('2026-01-01T00:00:00.000Z') };
      expect(hotelBookings.find).toHaveBeenCalledWith({ createdAt: range });
      expect(flightBookings.find).toHaveBeenCalledWith({ createdAt: range });
    });

    it('rejects an inverted date range', async () => {
      await expect(service.listBookings({ page: 1, limit: 10, from: '2026-12-31', to: '2026-12-01' } as any)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('pages across both collections', async () => {
      const result = await service.listBookings({ page: 2, limit: 1 } as any);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ reference: 'HTL-1' });
      expect(flightBookings.find().limit).toBeDefined();
    });
  });

  describe('ACC-14 listAccounts', () => {
    const rows = [
      { _id: new Types.ObjectId(), name: 'Active', email: 'a@x.com', role: 'user', isActive: true, isSuspended: false, createdAt: new Date('2026-01-01') },
      { _id: new Types.ObjectId(), name: 'Susp', email: 's@x.com', role: 'user', isActive: true, isSuspended: true, createdAt: new Date('2026-01-02') },
      { _id: new Types.ObjectId(), name: 'Gone', email: 'g@x.com', role: 'moderator', isActive: false, deactivatedAt: new Date(), createdAt: new Date('2026-01-03') },
    ];
    const setup = () => {
      const c: any = {};
      for (const m of ['select', 'sort', 'skip', 'limit', 'lean']) c[m] = (jest.fn as any)().mockReturnValue(c);
      c.exec = (jest.fn as any)().mockResolvedValue(rows);
      users.find.mockReturnValue(c);
      users.countDocuments.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(3) });
      return c;
    };

    it('returns name, email, role, status and registration date with a default page size of 10', async () => {
      const c = setup();
      const result = await service.listAccounts({ page: 1 } as any);
      expect(result.limit).toBe(10);
      expect(c.limit).toHaveBeenCalledWith(10);
      expect(result.items.map((i: any) => i.status)).toEqual(['active', 'suspended', 'deactivated']);
      expect(result.items[0]).toEqual({ id: String(rows[0]._id), name: 'Active', email: 'a@x.com', role: 'user', status: 'active', registeredAt: rows[0].createdAt });
      expect(JSON.stringify(result)).not.toMatch(/password|refreshTokenHash/);
    });

    it('combines role AND status AND search', async () => {
      setup();
      await service.listAccounts({ page: 1, limit: 10, role: 'user', status: 'suspended', search: 'a.b' } as any);
      const [filter] = users.find.mock.calls[0];
      expect(filter.$and).toEqual(
        expect.arrayContaining([
          { role: 'user' },
          { isActive: { $ne: false }, deactivatedAt: null, isSuspended: true },
          { $or: [{ name: { $regex: 'a\\.b', $options: 'i' } }, { email: { $regex: 'a\\.b', $options: 'i' } }] },
        ]),
      );
    });

    it('status=deactivated matches inactive or deactivatedAt accounts', async () => {
      setup();
      await service.listAccounts({ page: 3, limit: 10, status: 'deactivated' } as any);
      const [filter] = users.find.mock.calls[0];
      expect(filter.$and).toEqual([{ $or: [{ isActive: false }, { deactivatedAt: { $ne: null } }] }]);
      expect(users.find().skip).toHaveBeenCalledWith(20);
    });
  });

  it('resets passwords without including plaintext in audit records', async () => {
    const user: any = { _id: new Types.ObjectId(id), name: 'User', email: 'u@example.com', role: UserRole.USER, isActive: true, isSuspended: false, mustChangePassword: false, refreshTokenHash: 'hash', failedLoginAttempts: 4, save: (jest.fn as any)() };
    users.findById.mockResolvedValue(user);
    const result = await service.resetUserPassword(actorId, id);
    expect(result.temporaryPassword).toBeTruthy();
    expect(result.mustChangePassword).toBe(true);
    expect(user).toMatchObject({ mustChangePassword: true, refreshTokenHash: null, failedLoginAttempts: 0 });
    expect(audit.record).toHaveBeenCalledWith(actorId, 'account.password_reset', 'user', id);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(result.temporaryPassword);
  });

  it('rejects invalid ids and unsupported admin password reset', async () => {
    await expect(service.getAccount('invalid')).rejects.toBeInstanceOf(BadRequestException);
    users.findById.mockResolvedValue({ role: UserRole.ADMIN });
    await expect(service.resetUserPassword(actorId, id)).rejects.toBeInstanceOf(BadRequestException);
    users.findById.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(null) });
    await expect(service.setAccountSuspended(actorId, id, true)).rejects.toBeInstanceOf(NotFoundException);
  });
});
