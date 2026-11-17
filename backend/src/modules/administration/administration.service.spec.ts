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
    service = new AdministrationService(users, airlines, hotels, flightBookings, hotelBookings, audit, { createForUsers: (jest.fn as any)().mockResolvedValue(undefined) } as any, { find: (jest.fn as any)() } as any);
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

  it('returns platform-wide filtered booking counts and records', async () => {
    const flight = { createdAt: new Date('2026-01-02'), reference: 'F1' };
    const hotel = { createdAt: new Date('2026-01-01'), reference: 'H1' };
    flightBookings.find.mockReturnValue({ sort: (jest.fn as any)().mockReturnValue({ lean: (jest.fn as any)().mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue([flight]) }) }) });
    hotelBookings.find.mockReturnValue({ sort: (jest.fn as any)().mockReturnValue({ lean: (jest.fn as any)().mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue([hotel]) }) }) });
    flightBookings.countDocuments.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(1) });
    hotelBookings.countDocuments.mockReturnValue({ exec: (jest.fn as any)().mockResolvedValue(1) });
    const result = await service.listBookings({ page: 1, limit: 1 });
    expect(result.total).toBe(2);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ type: 'flight' });
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
