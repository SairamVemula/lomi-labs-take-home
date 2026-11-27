/** Public dev-only secrets that compose.yml injects when none are set. byok mode must refuse them. */
export const DEV_SESSION_SECRET = "dev-only-session-secret-change-me-0123456789abcdef";
export const DEV_KEY_ENCRYPTION_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/** Throws when byok is configured with the publicly known dev defaults. */
export function assertNoDevSecretsInByok(env: { sessionSecret?: string; keyEncryptionKey?: string }): void {
  if (env.sessionSecret === DEV_SESSION_SECRET || env.keyEncryptionKey === DEV_KEY_ENCRYPTION_KEY) {
    throw new Error("SESSION_SECRET/KEY_ENCRYPTION_KEY are the dev defaults; set real values for byok");
  }
}
