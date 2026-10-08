import { demo, until } from "./helpers";

/** Fresh contracts and demo state before the suite; every service back to normal. */
export default async function globalSetup(): Promise<void> {
  await until(
    async () => (await demo<{ deployment?: unknown }>("GET", "/state")).deployment,
    "the local stack (run npm run dev:stack first)",
    120_000,
  );
  await demo("POST", "/reset");
  await demo("POST", "/fund");
  await demo("POST", "/keeper/resume");
  for (let i = 1; i <= 9; i++)
    await demo("POST", `/sources/S${i}/mode`, { mode: "honest", offset: 0, down: false });
  const { nodes } = await demo<{ nodes: { id: string; running: boolean }[] }>("GET", "/nodes");
  for (const n of nodes) {
    await demo("POST", `/nodes/${n.id}/mode`, { mode: "honest" });
    if (!n.running) await demo("POST", `/nodes/${n.id}/start`);
  }
}
