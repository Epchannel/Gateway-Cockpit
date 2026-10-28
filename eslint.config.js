import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["admin/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
];
