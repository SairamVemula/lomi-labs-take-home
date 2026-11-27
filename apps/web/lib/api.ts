export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized: (() => void) | null = null;

/** Registered once by the app shell: runs when a (non-login) call answers 401. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const { code, message } = body as { code?: unknown; message?: unknown };
      if (typeof code === "string" && typeof message === "string") return new ApiError(res.status, code, message);
    }
  } catch {
    // not JSON (e.g. a proxy error page)
  }
  return new ApiError(res.status, `HTTP_${res.status}`, `Request failed (${res.status})`);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the server");
  }
  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 401 && path !== "/auth/login") onUnauthorized?.();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return send<T>("POST", path, body);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return send<T>("PUT", path, body);
}

/** Multipart upload; the browser sets the content-type boundary. */
export function apiUpload<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: "POST", body: form });
}
