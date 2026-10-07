import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SignedReport } from "../../shared/src";

/** Calls one tool of a source's MCP server and returns the signed report it produced. */
export async function fetchSignedReport(
  endpoint: string,
  tool: string,
  args: Record<string, string | number>,
): Promise<SignedReport> {
  const client = new Client({ name: "ties-oracle-node", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  try {
    await client.connect(transport);
    const result = (await client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
    };
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) throw new Error(text || "source returned an error");
    return JSON.parse(text) as SignedReport;
  } finally {
    await client.close().catch(() => undefined);
  }
}
