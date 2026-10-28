import { defineConfig } from "vitest/config";
export default defineConfig({
  ssr: { external: ["node:sqlite"] },
  test: {
    include: ["tests/**/*.test.ts", "admin/tests/**/*.test.tsx"],
    environment: "node",
    pool: "forks",
  },
});
