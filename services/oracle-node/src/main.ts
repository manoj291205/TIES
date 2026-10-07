import { makeLogger } from "../../shared/src";
import { startOracleService } from "./service";

startOracleService().catch((err) => {
  makeLogger("oracle-node").error(`failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
