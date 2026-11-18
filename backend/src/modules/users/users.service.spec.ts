import { jest } from '@jest/globals';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';
import { UsersService } from './users.service';
import { HotelBookingStatus } from '../hotel-bookings/schemas/hotel-booking.schema';
import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';
import { PostStatus } from '../blog/enums/post-status.enum';
import { ItineraryVisibility } from '../itineraries/enums/itinerary-visibility.enum';

describe('UsersService', () => {
  const id = new Types.ObjectId();
  let user: Record<string, any>;
  let userModel: any;
  let hotelBookings: any;
  let flightBookings: any;
  let posts: any;
  let itineraries: any;
  let currencies: any;
  let service: UsersService;

  beforeEach(() => {
    user = {
      _id: id, name: 'Amina', email: 'a@example.com', role: 'user', phone: null, preferredCurrency: 'EGP',
      isActive: true, isSuspended: false, deactivatedAt: null, mustChangePassword: false,
      refreshTokenHash: 'hash', failedLoginAttempts: 2, lockUntil: null,
      save: jest.fn(async () => user),
    };
    userModel = { findById: jest.fn(async () => user) };
    hotelBookings = { exists: jest.fn(async () => null) };
    flightBookings = { exists: jest.fn(async () => null) };
    posts = { updateMany: jest.fn(async () => ({})) };
    itineraries = { updateMany: jest.fn(async () => ({})) };
    currencies = {
      assertSupported: jest.fn(async (code: string) => {
        if (code.toUpperCase() !== 'USD' && code.toUpperCase() !== 'EGP') throw new BadRequestException(`Unsupported preferredCurrency "${code}"`);
        return code.toUpperCase();
      }),
    };
    service = new UsersService(userModel, currencies, hotelBookings, flightBookings, posts, itineraries);
  });

  describe('ACC-09 updateProfile', () => {
    it('updates name, phone and a supported currency', async () => {
      const result = await service.updateProfile(id.toString(), { name: ' New Name ', phone: '+20100', preferredCurrency: 'usd' });
      expect(user).toMatchObject({ name: 'New Name', phone: '+20100', preferredCurrency: 'USD' });
      expect(user.save).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ name: 'New Name', preferredCurrency: 'USD' });
      expect(result).not.toHaveProperty('password');
    });

    it('is all-or-nothing: an unsupported currency saves nothing, even if the name was valid', async () => {
      await expect(service.updateProfile(id.toString(), { name: 'Changed', preferredCurrency: 'XXX' })).rejects.toBeInstanceOf(BadRequestException);
      expect(user.save).not.toHaveBeenCalled();
    });

    it('requires at least one field and rejects a blank name', async () => {
      await expect(service.updateProfile(id.toString(), {})).rejects.toThrow('Provide at least one field to update');
      await expect(service.updateProfile(id.toString(), { name: '   ' })).rejects.toThrow('Name cannot be empty');
      expect(user.save).not.toHaveBeenCalled();
    });

    it('refuses a suspended or deactivated account', async () => {
      user.isSuspended = true;
      await expect(service.updateProfile(id.toString(), { name: 'x' })).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('ACC-12 deactivateAccount', () => {
    it('is blocked by an upcoming Confirmed hotel booking and changes nothing', async () => {
      hotelBookings.exists.mockResolvedValue({ _id: new Types.ObjectId() } as never);
      await expect(service.deactivateAccount(id.toString())).rejects.toBeInstanceOf(ConflictException);
      await expect(service.deactivateAccount(id.toString())).rejects.toThrow(/upcoming confirmed/i);
      expect(user.isActive).toBe(true);
      expect(user.save).not.toHaveBeenCalled();
      expect(posts.updateMany).not.toHaveBeenCalled();
      expect(itineraries.updateMany).not.toHaveBeenCalled();
    });

    it('is blocked by an upcoming Confirmed flight booking', async () => {
      flightBookings.exists.mockResolvedValue({ _id: new Types.ObjectId() } as never);
      await expect(service.deactivateAccount(id.toString())).rejects.toBeInstanceOf(ConflictException);
      expect(user.save).not.toHaveBeenCalled();
    });

    it('only upcoming CONFIRMED bookings block (queries exclude past, pending, cancelled, completed)', async () => {
      await service.deactivateAccount(id.toString());
      const [hotelFilter] = hotelBookings.exists.mock.calls[0];
      const [flightFilter] = flightBookings.exists.mock.calls[0];
      expect(hotelFilter).toEqual({ userId: id, status: HotelBookingStatus.CONFIRMED, checkOutDate: { $gt: expect.any(Date) } });
      // FLT-12: upcoming until the LAST flight departs (older one-way bookings: their only departure).
      const later = { $gt: expect.any(Date) };
      expect(flightFilter).toEqual({ userId: id, status: FlightBookingStatus.CONFIRMED, $or: [{ 'returnSegment.departureTime': later }, { returnSegment: null, departureTime: later }] });
    });

    it('deactivates, revokes the session, hides posts and makes public itineraries private', async () => {
      const result = await service.deactivateAccount(id.toString());
      expect(result.message).toMatch(/deactivated/i);
      expect(user).toMatchObject({ isActive: false, refreshTokenHash: null, failedLoginAttempts: 0, lockUntil: null });
      expect(user.deactivatedAt).toBeInstanceOf(Date);
      expect(user.save).toHaveBeenCalled();
      expect(posts.updateMany).toHaveBeenCalledWith({ authorId: id, status: PostStatus.PUBLISHED }, { $set: { status: PostStatus.HIDDEN } });
      expect(itineraries.updateMany).toHaveBeenCalledWith({ ownerId: id, visibility: ItineraryVisibility.PUBLIC }, { $set: { visibility: ItineraryVisibility.PRIVATE } });
    });

    it('cannot be repeated on an already deactivated account', async () => {
      user.isActive = false;
      user.deactivatedAt = new Date();
      await expect(service.deactivateAccount(id.toString())).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
