import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import onlyWarn from "eslint-plugin-only-warn";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * A shared ESLint configuration for the repository.
 *
 * TypeScript is parsed by typescript-eslint without type information: it does not support
 * TypeScript 7 yet, so this package pins TypeScript 6 for the parser only (the workspaces build
 * with 7). Move to the type-checked configs once typescript-eslint supports 7.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      // A leading underscore marks a binding kept on purpose (a rest sibling, a callback slot).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Variables the OS or CI sets for every process, not inputs that change a task's result.
      "turbo/no-undeclared-env-vars": [
        "warn",
        { allowList: ["^PATH$", "^TMPDIR$", "^CI$"] },
      ],
    },
  },
  {
    // Tests assert aligned columns; spaces written out read better than {n}.
    files: ["**/*.test.ts"],
    rules: {
      "no-regex-spaces": "off",
    },
  },
  {
    plugins: {
      onlyWarn,
    },
  },
  {
    ignores: ["dist/**"],
  },
];
