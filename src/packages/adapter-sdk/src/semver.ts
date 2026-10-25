// A tiny `satisfies` for the ranges `isSemverRange` accepts in the SDK: space-separated
// comparators (`>=`, `>`, `<=`, `<`, `=`, `^`, `~` or exact) over plain `a.b.c` versions.

type Version = [number, number, number];

const parse = (text: string): Version => {
  const [a, b, c] = text.split(".").map(Number);
  return [a!, b!, c!];
};

const compare = (x: Version, y: Version): number =>
  x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** The exclusive upper bound of `^v` (and `~v`, with `tilde`). */
function upper([major, minor, patch]: Version, tilde: boolean): Version {
  if (tilde) return [major, minor + 1, 0];
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

export function satisfiesRange(version: string, range: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const v = parse(version);
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const [, op = "", rest] = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(part)!;
      const bound = parse(rest!);
      const order = compare(v, bound);
      switch (op) {
        case ">=":
          return order >= 0;
        case ">":
          return order > 0;
        case "<=":
          return order <= 0;
        case "<":
          return order < 0;
        case "^":
        case "~":
          return order >= 0 && compare(v, upper(bound, op === "~")) < 0;
        default:
          return order === 0;
      }
    });
}
