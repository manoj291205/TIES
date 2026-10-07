/** Tiny timestamped logger; every service prefixes its lines with its own name. */
export interface Logger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export function makeLogger(name: string): Logger {
  const stamp = () => new Date().toISOString().slice(11, 23);
  const line = (level: string, msg: string, rest: unknown[]) =>
    console.log(`${stamp()} [${name}] ${level}${msg}`, ...rest);
  return {
    info: (msg, ...rest) => line("", msg, rest),
    warn: (msg, ...rest) => line("WARN ", msg, rest),
    error: (msg, ...rest) => line("ERROR ", msg, rest),
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}
