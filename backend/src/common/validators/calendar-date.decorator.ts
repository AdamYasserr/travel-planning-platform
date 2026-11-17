import { ValidationOptions, registerDecorator } from 'class-validator';

/** True for a real calendar date written exactly as YYYY-MM-DD (so 2026-02-30 and 2026-1-5 are rejected). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

export function IsCalendarDate(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isCalendarDate',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must be a real date in YYYY-MM-DD format`, ...options },
      validator: { validate: (value: unknown) => isCalendarDate(value) },
    });
}
