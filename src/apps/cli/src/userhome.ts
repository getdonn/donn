import { homedir, userInfo } from "node:os";

/** The home folder the system records for this user (passwd), which HOME cannot change. */
export function passwdHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The user's home folder: HOME when it is set and not empty, else the system's record of it
 * (`passwd` is the test seam), else os.homedir(). An empty HOME counts as unset; os.homedir()
 * alone would return it as is.
 */
export function userHomeDir(
  env: { HOME?: string | undefined },
  passwd: () => string | undefined = passwdHome,
): string {
  return env.HOME || passwd() || homedir();
}
