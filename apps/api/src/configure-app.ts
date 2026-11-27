import type { NestExpressApplication } from "@nestjs/platform-express";
import type { ApiConfig } from "./config.js";

/** HTTP settings shared by main.ts and the tests. */
export function configureApp(app: NestExpressApplication, config: ApiConfig): void {
  // The web app proxies /api/* here, so the client IP (login throttle) comes from X-Forwarded-For.
  app.set("trust proxy", config.trustProxyHops);
}
