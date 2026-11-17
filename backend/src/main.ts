import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { createValidationPipe } from './common/pipes/validation.pipe';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
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

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Travel Planning Platform API')
    .setDescription('Backend API documentation')
    .setVersion('1.0')
    .addCookieAuth('access_token')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  SwaggerModule.setup('docs', app, document);

  const port = configService.get<number>('app.port') ?? 3000;

  await app.listen(port);
}

bootstrap();
