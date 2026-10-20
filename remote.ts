import { isSpaceOS, runProcess, type ProcessSpec, type SpaceItem, type SpaceOS, type SpacesClient } from "./spaces.ts";
import { probeWindows } from "./windows.ts";

export type Remote = {
  client: SpacesClient;
  spaceId: string;
  name: string;
  os: SpaceOS;
  home: string;
  shell?: string;
  nodeDirectory?: string;
};

export function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const pathPrefix = 'export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"\n';

export function shellCommand(remote: Remote, script: string): Pick<ProcessSpec, "program" | "args"> {
  if (remote.os !== "windows") return { program: "/bin/sh", args: ["-c", pathPrefix + script] };
  if (!remote.shell || !remote.nodeDirectory) throw new Error("Windows shell prerequisites have not been resolved");
  const prefix = `export HOME=${sh(remote.home)}\nexport PATH="/usr/bin:/bin:/mingw64/bin:/mingw32/bin:$PATH"\nexport PATH="$(cygpath -u ${sh(remote.nodeDirectory)}):$PATH"\nexport MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 MSYS=winsymlinks:nativestrict\n`;
  return { program: remote.shell, args: ["--noprofile", "--norc", "-c", prefix + script] };
}

export function layout(home: string) {
  const root = `${home}/.cua-pi`;
  return {
    root,
    repo: (key: string) => `${root}/repos/${key}.git`,
    work: (executionId: string) => `${root}/work/${executionId}`,
  };
}

const inlineLimit = 384 * 1024;

export type CommandResult = { exitCode: number | null; timedOut: boolean; stdout: Buffer; stderr: string; error: string | null };

export async function run(
  remote: Remote,
  script: string,
  options: { timeoutMs?: number; signal?: AbortSignal; check?: boolean; label?: string; input?: Buffer } = {},
): Promise<CommandResult> {
  const inline = remote.os !== "windows" && options.input && options.input.length <= inlineLimit;
  const encoded = inline ? options.input!.toString("base64").match(/.{1,65536}/g) ?? [] : [];
  const command = inline
    ? { program: "/bin/sh", args: ["-c", `printf %s "$@" | base64 -d | /bin/sh -c ${sh(pathPrefix + script)}`, "sh", ...encoded] }
    : shellCommand(remote, script);
  const exit = await runProcess(
    remote.client,
    remote.spaceId,
    { ...command, timeoutMs: options.timeoutMs ?? 120_000 },
    inline ? undefined : options.input,
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

export type Probe = { home: string; machineId: string; freeBytes: number };

export async function probe(
  client: SpacesClient,
  space: SpaceItem,
  signal?: AbortSignal,
): Promise<{ remote: Remote; probe: Probe }> {
  if (!isSpaceOS(space.os))
    throw new Error(`${space.name} runs ${space.os || "an unknown OS"}; pi-cua supports Linux, macOS and experimental Windows Spaces`);
  if (space.os === "windows") {
    const windows = await probeWindows(client, space, signal);
    await run(windows.remote, 'set -eu\nnode -e \'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)\'\nfor tool in git tar cat mkdir mv rm df awk base64 cygpath; do command -v "$tool" >/dev/null; done', { signal, timeoutMs: 30_000, label: "Git Bash prerequisite check" });
    return windows;
  }
  const partial: Remote = { client, spaceId: space.id, name: space.name, os: space.os, home: "" };
  const machineId =
    space.os === "macos"
      ? `ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ { print $4 }'`
      : "cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id";
  const result = await run(
    partial,
    `missing=""
for tool in node git; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
if [ -n "$missing" ]; then echo "missing:$missing" >&2; exit 20; fi
printf 'home=%s\\n' "$HOME"
mkdir -p "$HOME/.cua-pi"
[ -s "$HOME/.cua-pi/machine-id" ] || node -e 'process.stdout.write(require("node:crypto").randomUUID())' > "$HOME/.cua-pi/machine-id"
printf 'machine=%s/%s\\n' "$(${machineId})" "$(cat "$HOME/.cua-pi/machine-id")"
printf 'free=%s\\n' "$(( $(df -Pk "$HOME" | awk 'NR == 2 { print $4 }') * 1024 ))"`,
    { timeoutMs: 30_000, signal, label: "prerequisite check", check: false },
  );
  if (result.exitCode === 20)
    throw new Error(
      `${space.name} is missing${result.stderr.replace(/^missing:/, "").trim().replace(/^/, " ")}; install Node.js 22+ and git there, then try again`,
    );
  if (result.exitCode !== 0)
    throw new Error(`prerequisite check on ${space.name} failed: ${(result.stderr || result.stdout.toString("utf8")).trim().slice(-500)}`);
  const fields = Object.fromEntries(
    result.stdout
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  if (!fields.home?.startsWith("/") || !fields.machine || !/^\d+$/.test(fields.free ?? ""))
    throw new Error(`invalid prerequisite response from ${space.name}`);
  return {
    remote: { ...partial, home: fields.home },
    probe: { home: fields.home, machineId: fields.machine.trim(), freeBytes: Number(fields.free) },
  };
}
