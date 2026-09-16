import { defineConfig } from "vitest/config";

// Pure modules run in Node (they use only Web Crypto and TextEncoder, which
// Node provides). The Worker and its Durable Objects run in the Workers runtime
// through vitest.worker.config.ts.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.spec.ts"],
  },
});
