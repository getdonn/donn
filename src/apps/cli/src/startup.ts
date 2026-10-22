// Before the CLI runs: the working folder. A shell left in a folder that was deleted (a branch
// switch, say) has none, and Node's own error for that is a stack trace.

const GONE = "the current folder no longer exists; cd into it again";

export function workingDir(
  cwd: () => string = () => process.cwd(),
): { cwd: string } | { error: string } {
  try {
    return { cwd: cwd() };
  } catch (error) {
    const { code, syscall } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" && syscall === "uv_cwd") return { error: GONE };
    throw error;
  }
}
