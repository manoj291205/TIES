import { exportAbis } from "./lib/abi";

for (const file of exportAbis()) console.log(`wrote ${file}`);
