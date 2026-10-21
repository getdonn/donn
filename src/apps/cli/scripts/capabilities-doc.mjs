// Writes docs/capabilities.md from the built CLI: the first-party adapters' matrices, without
// detection. Run through `pnpm docs:capabilities`, which builds first.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  capabilitiesDoc,
  firstPartyColumns,
} from "../dist/capabilities/render.js";

writeFileSync(
  join(import.meta.dirname, "../../../../docs/capabilities.md"),
  capabilitiesDoc(firstPartyColumns()),
);
