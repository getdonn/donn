/** Compares `x.y.z` versions, newest first. */
export function newestFirst(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) {
    const d = (y?.[i] ?? 0) - (x?.[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
