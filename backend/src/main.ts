import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module';
import { APP_OPTIONS, configureApp, configureSwagger } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { ...APP_OPTIONS });
  const configService = app.get(ConfigService);

  configureApp(app);
  configureSwagger(app);

  const port = configService.get<number>('app.port') ?? 3000;

  await app.listen(port);
}

bootstrap();
