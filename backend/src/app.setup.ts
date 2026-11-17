import { INestApplication, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { createValidationPipe } from './common/pipes/validation.pipe';

/** Options for NestFactory.create / createNestApplication. rawBody is needed by the Stripe webhook. */
export const APP_OPTIONS = { rawBody: true } as const;

/** Everything main.ts configures except Swagger. Shared with the e2e tests so they cannot drift. */
export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);

  app.setGlobalPrefix('api');

  app.use(helmet());
  app.use(cookieParser());

  app.enableCors({
    origin: configService.get<string[]>('app.corsOrigins'),
    credentials: true,
  });

  app.useGlobalPipes(createValidationPipe());

  if (
    configService.get<string>('app.environment') === 'production' &&
    !configService.get<boolean>('auth.cookieSecure')
  ) {
    new Logger('Bootstrap').warn(
      'COOKIE_SECURE is off in production: auth cookies are not marked Secure. Set COOKIE_SECURE=true behind HTTPS.',
    );
  }
}

/** Swagger UI at /docs. Returns the document so tests can inspect it. */
export function configureSwagger(app: INestApplication) {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Travel Planning Platform API')
    .setDescription('Backend API documentation')
    .setVersion('1.0')
    .addCookieAuth('access_token')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup('docs', app, document);
  return document;
}
