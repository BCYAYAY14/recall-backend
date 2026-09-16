import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          r2Buckets: ["MEDIA"],
          d1Databases: ["META"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            OWNER_SETUP_CODE: "synthetic-setup-code-0001",
            DEPLOYED_AT: new Date().toISOString(),
          },
        },
      }),
    ],
    test: {
      include: ["test/worker/**/*.spec.ts"],
      setupFiles: ["./test/worker/apply-migrations.ts"],
    },
  };
});
