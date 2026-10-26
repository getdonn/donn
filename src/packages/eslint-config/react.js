import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { config as base } from "./base.js";

/**
 * The base configuration plus the rules of hooks, for the React app.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  ...base,
  {
    ...reactHooks.configs.flat["recommended-latest"],
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
];
