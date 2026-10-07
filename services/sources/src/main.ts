import { makeLogger } from "../../shared/src";
import { startSources } from "./index";

startSources().catch((err) => {
  makeLogger("sources").error(`failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
