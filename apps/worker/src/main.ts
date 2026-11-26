import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module.js";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM/SIGINT -> onApplicationShutdown: close the BullMQ worker, leave unfinished runs to the reconciler.
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
