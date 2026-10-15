import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Both PostgreSQL integration suites start embedded servers on separate ports.
    fileParallelism: false,
    coverage: { reporter: ["text", "json", "html"] },
    environment: "node",
  },
});
