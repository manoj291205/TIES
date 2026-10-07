import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "artifacts/**",
      "cache/**",
      "typechain-types/**",
      "coverage/**",
      "**/dist/**",
      ".solcover.js",
      "reference/**",
      "frontend/ties-design/**",
      "frontend/dist/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
