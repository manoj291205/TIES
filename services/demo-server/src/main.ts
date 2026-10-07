import { makeLogger } from "../../shared/src";
import { startDemoServer } from "./server";

startDemoServer().catch((err) => {
  makeLogger("demo-server").error(`failed to start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
