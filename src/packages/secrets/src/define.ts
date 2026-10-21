import { BUILT_IN_TYPES, type SecretBackend } from "./secrets.js";

// The contract for secret provider packages, loaded from `secretProviders:` in config.yaml.
// See docs/planning/08-cli-reach.md, section 1.

export const SECRET_PROVIDER_API_VERSION = 1;

export interface SecretProvider extends SecretBackend {
  apiVersion: 1;
}

/** The provider's declaration is invalid: a bad or built-in type, or no resolve. */
export class SecretProviderDeclarationError extends Error {
  override name = "SecretProviderDeclarationError";
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Stamp the contract version on a provider and check its declaration. */
export function defineSecretProvider(
  declaration: SecretBackend,
): SecretProvider {
  const fail = (problem: string) => {
    throw new SecretProviderDeclarationError(
      `secret provider ${JSON.stringify(declaration.type)}: ${problem}`,
    );
  };
  if (typeof declaration.type !== "string" || !KEBAB.test(declaration.type))
    fail("type must be lowercase kebab-case");
  if (BUILT_IN_TYPES.includes(declaration.type))
    fail("type is built in and cannot be replaced");
  if (typeof declaration.resolve !== "function") fail("resolve is missing");
  // Named fields, not a spread: a class instance keeps its resolve method.
  return {
    apiVersion: SECRET_PROVIDER_API_VERSION,
    type: declaration.type,
    resolve: declaration.resolve.bind(declaration),
  };
}
