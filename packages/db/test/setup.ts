import { GenericContainer, Wait } from "testcontainers";
import { createDb, type Db } from "../src/client.js";
import { migrateToLatest } from "../src/migrate.js";

export async function startTestDb(): Promise<{ db: Db; url: string; stop: () => Promise<void> }> {
  const container = await new GenericContainer("postgres:17-alpine")
    .withEnvironment({ POSTGRES_USER: "test", POSTGRES_PASSWORD: "test", POSTGRES_DB: "test" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;
  await migrateToLatest(url);
  const { db, close } = createDb(url);
  return {
    db,
    url,
    stop: async () => {
      await close();
      await container.stop();
    },
  };
}
