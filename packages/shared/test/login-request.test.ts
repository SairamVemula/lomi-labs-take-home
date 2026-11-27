import { describe, expect, it } from "vitest";
import { LoginRequest } from "../src/index.js";

describe("LoginRequest", () => {
  it("accepts a missing or empty API key (keyless local servers); defaults to empty string", () => {
    expect(LoginRequest.parse({ baseUrl: "http://host.docker.internal:1234/v1", model: "qwen3-8b" })).toEqual({
      baseUrl: "http://host.docker.internal:1234/v1",
      apiKey: "",
      model: "qwen3-8b",
    });
    expect(LoginRequest.safeParse({ baseUrl: "http://x/v1", apiKey: "", model: "m" }).success).toBe(true);
  });
  it("still requires base URL and model", () => {
    expect(LoginRequest.safeParse({ baseUrl: "", model: "m" }).success).toBe(false);
    expect(LoginRequest.safeParse({ baseUrl: "http://x/v1", model: "" }).success).toBe(false);
  });
});
