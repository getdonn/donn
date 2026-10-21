import { good } from "../testing/toy.js";
import { conformanceSuite } from "./suite.js";

// The vitest wrapper registers one test per check (and per corpus entry for per-entry checks);
// for the toy adapter they must all pass.
conformanceSuite(good);
