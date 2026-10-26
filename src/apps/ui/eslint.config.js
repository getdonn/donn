import { config } from "@getdonn/eslint-config/react";

export default [
  ...config,
  { ignores: ["test-results/**", "playwright-report/**"] },
];
