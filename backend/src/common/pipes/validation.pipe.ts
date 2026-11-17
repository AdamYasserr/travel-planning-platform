import { BadRequestException, ValidationError, ValidationPipe } from '@nestjs/common';

export interface FieldError {
  field: string;
  messages: string[];
}

/** Flattens (possibly nested) class-validator errors into `{ field, messages }` entries with dotted paths. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  const out: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) out.push({ field, messages: Object.values(error.constraints) });
    if (error.children?.length) out.push(...flattenValidationErrors(error.children, field));
  }
  return out;
}

/** Throws the same 400 body as the ValidationPipe, for checks that need several fields (e.g. min > max). */
export function fieldErrors(errors: FieldError[]): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Validation failed', errors });
}

/** Field-level validation errors: `{ statusCode, error, message, errors: [{ field, messages }] }`. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) =>
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        errors: flattenValidationErrors(errors),
      }),
  });
}
