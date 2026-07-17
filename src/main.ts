import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Enable CORS for cross-origin requests (mobile apps / dashboards)
  app.enableCors();

  // Global validation pipe: strips unknown props, transforms payloads to DTO instances
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter to standardize error responses across the API
  app.useGlobalFilters(new GlobalExceptionFilter());

  // Global interceptor to log every request/response cycle with timing
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Swagger / OpenAPI documentation setup
  const config = new DocumentBuilder()
    .setTitle('Vybe Cabs Backend API')
    .setDescription(
      'Production-ready ride-hailing backend: driver geo-tracking, nearest-driver search, ' +
        'concurrency-safe ride assignment via Redis distributed locks, timeout/retry flow.',
    )
    .setVersion('1.0')
    .addTag('drivers')
    .addTag('rides')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`🚕 Vybe Cabs Backend running on http://localhost:${port}`);
  logger.log(`📚 Swagger docs available at http://localhost:${port}/api/docs`);
}
bootstrap();
