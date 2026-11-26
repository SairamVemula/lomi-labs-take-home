export const sharedTestConfig = {
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
  },
};

export const sharedIntegrationConfig = {
  test: {
    environment: "node",
    include: ["**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
};
