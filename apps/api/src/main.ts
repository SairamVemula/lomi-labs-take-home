import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import type { ApiConfig } from "./config.js";
import { configureApp } from "./configure-app.js";
import { CONFIG, STORAGE } from "./tokens.js";
import type { FileStorage } from "@lomi/storage";

async function main(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ApiConfig>(CONFIG);
  configureApp(app, config);
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  await app.listen(config.port, "0.0.0.0");
  console.log(`api listening on :${config.port} (auth ${config.authMode}, storage: ${app.get<FileStorage>(STORAGE).kind})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
