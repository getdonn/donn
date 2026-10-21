/** A build or plan the executor refuses or cannot carry out. */
export class ExecutorError extends Error {
  override name = "ExecutorError";
}
