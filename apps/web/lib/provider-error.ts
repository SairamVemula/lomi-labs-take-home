import { ApiError } from "./api";

/** Title + detail for an LLM-provider verification failure, shared by login and settings. */
export function providerError(err: unknown, fallbackTitle: string): { title: string; detail: string } | null {
  if (!err) return null;
  const detail = err instanceof Error ? err.message : String(err);
  const code = err instanceof ApiError ? err.code : undefined;
  const title =
    code === "PROVIDER_REJECTED"
      ? "The provider rejected this request."
      : code === "PROVIDER_UNREACHABLE"
        ? "Couldn't reach the provider."
        : code === "INVALID_BASE_URL"
          ? "This base URL isn't allowed."
          : code === "API_KEY_REQUIRED"
            ? "An API key is required."
            : fallbackTitle;
  return { title, detail };
}
