import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "src/server.ts",
    "scripts/bootstrap-admin": "scripts/bootstrap-admin.ts",
    "scripts/init-sql-engine": "scripts/init-sql-engine.ts",
    "scripts/sync-indexes": "scripts/sync-indexes.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Keep dependencies external; they are installed in the runtime image.
  skipNodeModulesBundle: true,
  tsconfig: "tsconfig.json",
});
