import { type MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import cookieParser from "cookie-parser";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import type { ApiConfig } from "./config.js";
import { CoreModule } from "./core.module.js";
import { DocumentsController } from "./documents/documents.controller.js";
import { DocumentsService } from "./documents/documents.service.js";
import { ValuesController } from "./values/values.controller.js";
import { ApiExceptionFilter } from "./errors.js";
import { HealthController } from "./health.controller.js";
import { SettingsController } from "./settings/settings.controller.js";
import { CONFIG } from "./tokens.js";

@Module({
  imports: [
    CoreModule,
    // Only POST /auth/login opts in (@UseGuards(ThrottlerGuard)); nothing else is rate limited.
    ThrottlerModule.forRootAsync({
      imports: [CoreModule],
      inject: [CONFIG],
      useFactory: (c: ApiConfig) => [{ ttl: 60_000, limit: c.loginRateLimit }],
    }),
  ],
  controllers: [HealthController, AuthController, SettingsController, DocumentsController, ValuesController],
  providers: [
    AuthService,
    DocumentsService,
    // Every route needs a user unless marked @Public(); later controllers inherit this.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes("*path");
  }
}
