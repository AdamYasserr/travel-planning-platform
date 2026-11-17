import { BadRequestException } from '@nestjs/common';
import { RegisterDto } from '../../auth/dto/register.dto';
import { ChangePasswordDto } from '../../auth/dto/change-password.dto';
import { DeactivateAccountDto } from '../../auth/dto/deactivate-account.dto';
import { UpdateProfileDto } from '../../users/dto/update-profile.dto';
import { createValidationPipe } from './validation.pipe';

const pipe = createValidationPipe();
const run = (metatype: any, value: unknown) => pipe.transform(value, { type: 'body', metatype });
const failure = async (metatype: any, value: unknown) => {
  try {
    await run(metatype, value);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as any;
  }
  throw new Error('expected validation to fail');
};
const fieldMessages = (res: any, field: string) => res.errors.find((e: any) => e.field === field)?.messages ?? [];

const valid = { name: 'Amina Hassan', email: 'amina@example.com', password: 'Passw0rdOK', acceptTerms: true };

describe('ValidationPipe error shape', () => {
  it('returns { message, errors: [{ field, messages }] }', async () => {
    const res = await failure(RegisterDto, { ...valid, password: 'short' });
    expect(res).toMatchObject({ statusCode: 400, message: 'Validation failed' });
    expect(res.errors).toEqual(expect.arrayContaining([{ field: 'password', messages: expect.any(Array) }]));
  });
});

describe('ACC-01 register validation', () => {
  it('accepts a valid payload and trims the name', async () => {
    const dto: RegisterDto = await run(RegisterDto, { ...valid, name: '  Amina  ' });
    expect(dto.name).toBe('Amina');
  });

  it.each([
    ['too short', 'Ab1'],
    ['no digit', 'OnlyLetters'],
    ['no letter', '12345678'],
  ])('rejects a weak password (%s) with a field-level error', async (_label, password) => {
    const res = await failure(RegisterDto, { ...valid, password });
    expect(fieldMessages(res, 'password').length).toBeGreaterThan(0);
    expect(res.errors.map((e: any) => e.field)).toEqual(['password']);
  });

  it('requires consent to be exactly true', async () => {
    for (const acceptTerms of [false, undefined, 'true', 1]) {
      const res = await failure(RegisterDto, { ...valid, acceptTerms });
      expect(res.errors.map((e: any) => e.field)).toContain('acceptTerms');
    }
  });

  it('reports every invalid field at once', async () => {
    const res = await failure(RegisterDto, { name: '', email: 'nope', password: 'x', acceptTerms: false });
    expect(res.errors.map((e: any) => e.field).sort()).toEqual(['acceptTerms', 'email', 'name', 'password']);
  });

  it('limits the password to 72 BYTES, not characters', async () => {
    const ascii72 = 'a1' + 'b'.repeat(70);
    await expect(run(RegisterDto, { ...valid, password: ascii72 })).resolves.toBeDefined();
    await expect(run(RegisterDto, { ...valid, password: ascii72 + 'b' })).rejects.toBeInstanceOf(BadRequestException);
    // 30 characters but 3 bytes each = 90 bytes + letter/digit
    const unicode = 'a1' + '€'.repeat(30);
    expect(unicode.length).toBeLessThan(72);
    expect(Buffer.byteLength(unicode)).toBeGreaterThan(72);
    const res = await failure(RegisterDto, { ...valid, password: unicode });
    expect(fieldMessages(res, 'password').join(' ')).toMatch(/72 bytes/);
  });

  it('rejects unknown fields (e.g. privilege escalation)', async () => {
    const res = await failure(RegisterDto, { ...valid, role: 'admin' });
    expect(res.errors.map((e: any) => e.field)).toContain('role');
  });
});

describe('ACC-12 deletion confirmation', () => {
  it('requires confirm to be exactly true (the string "false" must not count)', async () => {
    await expect(run(DeactivateAccountDto, { confirm: true })).resolves.toBeDefined();
    for (const confirm of [false, 'false', 'true', 1, undefined]) {
      await expect(run(DeactivateAccountDto, { confirm })).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('ACC-08 change-password validation', () => {
  it('enforces the same rules and the byte limit on the new password', async () => {
    await expect(run(ChangePasswordDto, { currentPassword: 'x', newPassword: 'Newpass123' })).resolves.toBeDefined();
    for (const newPassword of ['short1', 'nodigitshere', '123456789', 'a1' + '€'.repeat(30)]) {
      const res = await failure(ChangePasswordDto, { currentPassword: 'x', newPassword });
      expect(res.errors.map((e: any) => e.field)).toEqual(['newPassword']);
    }
  });
});

describe('ACC-09 profile validation', () => {
  it('only name, phone and preferredCurrency are accepted', async () => {
    const dto: UpdateProfileDto = await run(UpdateProfileDto, { name: 'New', phone: '+201001234567', preferredCurrency: 'usd' });
    expect(dto.preferredCurrency).toBe('USD');
    for (const forbidden of ['email', 'role', 'password', 'isSuspended', 'mustChangePassword']) {
      const res = await failure(UpdateProfileDto, { name: 'New', [forbidden]: 'x' });
      expect(res.errors.map((e: any) => e.field)).toContain(forbidden);
    }
  });

  it('is all-or-nothing at the validation layer: one bad field rejects everything', async () => {
    const res = await failure(UpdateProfileDto, { name: 'Valid Name', preferredCurrency: 'DOLLARS' });
    expect(res.errors.map((e: any) => e.field)).toEqual(['preferredCurrency']);
  });
});
