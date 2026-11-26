import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import type { ApiConfig } from "./config.js";
import { CONFIG } from "./tokens.js";

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ApiConfig>(CONFIG);
  // The web app proxies /api/* here, so the client IP (login throttle) comes from X-Forwarded-For.
  app.set("trust proxy", config.trustProxyHops);
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  await app.listen(config.port, "0.0.0.0");
  console.log(`api listening on :${config.port} (auth ${config.authMode})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
