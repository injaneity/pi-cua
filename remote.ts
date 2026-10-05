import { runProcess, type SpaceOS, type SpacesClient } from "./spaces.ts";

export type Remote = {
  client: SpacesClient;
  spaceId: string;
  name: string;
  os: SpaceOS;
  home: string;
};

export function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const pathPrefix = 'export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"\n';

export function layout(home: string) {
  const root = `${home}/.cua-pi`;
  return {
    root,
    npmCache: `${root}/npm-cache`,
    pi: (version: string) => `${root}/pi/${version}`,
    runtime: (hash: string) => `${root}/runtimes/${hash}`,
    repo: (key: string) => `${root}/repos/${key}.git`,
    work: (executionId: string) => `${root}/work/${executionId}`,
  };
}

export type CommandResult = { exitCode: number | null; timedOut: boolean; stdout: Buffer; stderr: string; error: string | null };

export async function run(
  remote: Remote,
  script: string,
  options: { timeoutMs?: number; signal?: AbortSignal; check?: boolean; label?: string; input?: Buffer } = {},
): Promise<CommandResult> {
  const exit = await runProcess(
    remote.client,
    remote.spaceId,
    { program: "/bin/sh", args: ["-c", `${pathPrefix}${script}`], timeoutMs: options.timeoutMs ?? 120_000 },
    options.input,
    options.signal,
  );
  const result = { exitCode: exit.code, timedOut: exit.timedOut === true, stdout: exit.stdout, stderr: exit.stderr, error: exit.error };
  if (options.check !== false && (result.exitCode !== 0 || result.timedOut)) {
    const detail = (result.stderr || result.stdout.toString("utf8") || result.error || "").trim().slice(-2000);
    const status = result.timedOut ? "timed out" : `failed with exit ${result.exitCode ?? exit.signal ?? "unknown"}`;
    throw new Error(`${options.label ?? "command"} on ${remote.name} ${status}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}
