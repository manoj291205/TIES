/** Client for the localhost-only demo server (REST and server-sent events). */
export const DEMO_URL =
  (import.meta.env.VITE_DEMO_URL as string | undefined) ?? "http://127.0.0.1:7000";

export async function demoGet<T>(path: string): Promise<T> {
  const res = await fetch(`${DEMO_URL}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function demoPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DEMO_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** POST an endpoint that answers with server-sent events and call `onEvent` for each one. */
export async function demoStream(
  path: string,
  onEvent: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const res = await fetch(`${DEMO_URL}${path}`, { method: "POST" });
  if (!res.ok || !res.body) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) onEvent(event, JSON.parse(data) as Record<string, unknown>);
    }
  }
}

export interface ExperimentSummary {
  generatedAt: string;
  config: {
    eventsPerScenario: number;
    policiesPerEvent: number;
    sweepEvents: number;
    seed: number;
    notes: string[];
  };
  scenarios: Record<
    string,
    {
      title: string;
      ties: {
        wrongRate: number;
        autoRate: number;
        defaultRate: number;
        heldRate: number;
        oracleTxsPerEvent: number;
        oracleGasPerEvent: number;
        settleGasPerEvent: number;
        gasPerPolicy: number;
        roundsPerEvent: number;
      };
      baselines: Record<
        string,
        {
          wrongRate: number;
          settledRate: number;
          oracleTxsPerEvent: number;
          oracleGasPerEvent: number;
          settleGasPerEvent: number;
          gasPerPolicy: number;
        }
      >;
    }
  >;
  gasVsPolicies: {
    n: number;
    tiesFinalizeRound: number;
    tiesApplyDefault: number | null;
    baselines: Record<string, number | string>;
  }[];
}

/** The experiment results produced by `npx hardhat run experiments/run.ts`; null when none exist yet. */
export async function loadExperiments(): Promise<ExperimentSummary | null> {
  try {
    const res = await fetch("/experiments/latest.json", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as ExperimentSummary;
  } catch {
    return null;
  }
}
