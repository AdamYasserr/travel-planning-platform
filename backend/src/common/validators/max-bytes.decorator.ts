import { ValidationOptions, registerDecorator } from 'class-validator';

/** bcrypt only uses the first 72 BYTES of a password; Unicode characters can take up to 4 bytes each. */
export const BCRYPT_MAX_PASSWORD_BYTES = 72;

export function MaxBytes(max: number, options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'maxBytes',
      target: object.constructor,
      propertyName,
      constraints: [max],
      options: { message: `${propertyName} must not exceed ${max} bytes (UTF-8)`, ...options },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max,
      },
    });
}
