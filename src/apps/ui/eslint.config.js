import { config } from "@getdonn/eslint-config/base";

export default [
  ...config,
  { ignores: ["test-results/**", "playwright-report/**"] },
];
