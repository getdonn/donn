# `@getdonn/eslint-config`

Shared ESLint config for the monorepo. Internal; never published.

- `@getdonn/eslint-config/base`: `@eslint/js` and typescript-eslint's recommended rules for `.ts`
  and `.js` files, with Node globals.
- `@getdonn/eslint-config/react`: `base` plus the rules of hooks and browser globals for `src/`
  (the web app).

typescript-eslint does not support TypeScript 7 yet, so this package pins TypeScript 6 for the
parser only and uses no type-aware rules; the workspaces still build and type-check with 7. Move to
typescript-eslint's type-checked configs once it supports 7.
