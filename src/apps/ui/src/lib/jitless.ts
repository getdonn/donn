import { z } from "zod";

// zod compiles object parsers with `new Function` when it can, and finds out by trying one: under
// the bridge's CSP (no 'unsafe-eval') that try is a console error. Imported first in main.tsx,
// so it runs before any schema (built when @getdonn/cli-schemas loads) is created.
z.config({ jitless: true });
