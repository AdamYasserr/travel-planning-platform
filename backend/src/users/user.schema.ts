import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { UserRole } from '../common/enums/user-role.enum';

export type UserDocument = HydratedDocument<User>;

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop({ type: String, enum: UserRole, default: UserRole.USER })
  role: UserRole;

  @Prop({ type: String, trim: true, default: null })
  phone?: string | null;

  @Prop({ type: String, default: 'EGP' })
  preferredCurrency: string;

  @Prop({ type: Date, required: true, default: Date.now })
  termsAcceptedAt: Date;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  isSuspended: boolean;

  @Prop({ type: Number, default: 0 })
  failedLoginAttempts: number;

  @Prop({ type: Date, default: null })
  lockUntil?: Date | null;

  @Prop({ type: Boolean, default: false })
  mustChangePassword: boolean;

  @Prop({ type: String, default: null })
  hotelId?: string | null;

  @Prop({ type: String, default: null })
  airlineId?: string | null;

  /** SHA-256 of the current refresh token (never exposed; select: false). */
  @Prop({ type: String, default: null, select: false })
  refreshTokenHash?: string | null;

  @Prop({ type: Date, default: null })
  deactivatedAt?: Date | null;

  @Prop({ type: Date, default: Date.now })
  lastActivityAt: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);