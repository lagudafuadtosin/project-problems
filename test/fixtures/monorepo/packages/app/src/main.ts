import { greet } from "../../core/src/index";
import { shared } from "../../core/src/broken";
export const msg = greet(42);
export const s = shared;
