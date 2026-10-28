import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  root: "admin",
  base: "/admin/",
  build: { outDir: "../dist/admin", emptyOutDir: true },
  test: { root: ".", include: ["../tests/**/*.test.ts"] },
});
