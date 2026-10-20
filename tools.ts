import { basename, dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import { tmpdir } from "node:os";
import type { BashOperations, EditOperations, FindOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { run, sh, shellCommand, type Remote } from "./remote.ts";
import { runProcess } from "./spaces.ts";

export type SpaceOperations = {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  bash: BashOperations;
  find: FindOperations;
  grep: (args: string[], cwd: string, signal?: AbortSignal) => Promise<string>;
  remotePath: (path: string) => string;
};

const imageTypes: Array<[string, number[]]> = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/webp", [0x52, 0x49, 0x46, 0x46]],
];

export function localClipboard(path: string): boolean {
  return isAbsolute(path) && resolve(dirname(path)) === resolve(tmpdir()) && /^pi-clipboard-[\w-]+\.(png|jpg|jpeg|gif|webp)$/i.test(basename(path));
}

export function spaceOperations(remote: Remote, localCwd: string, remoteCwd: string): SpaceOperations {
  const localRoot = process.platform === "win32" ? localCwd.replaceAll("\\", "/") : localCwd;
  const remotePath = (path: string) => {
    if (process.platform === "win32") path = path.replaceAll("\\", "/");
    const comparable = process.platform === "win32" ? path.toLowerCase() : path;
    const root = process.platform === "win32" ? localRoot.toLowerCase() : localRoot;
    const local = comparable === root || comparable.startsWith(`${root}/`);
    if (remote.os === "windows") {
      const supplied = local ? path.slice(localRoot.length + 1) : path;
      if (supplied.startsWith("\\") || supplied.startsWith("//") || /^[a-z]:[^\\/]/i.test(supplied) || /^[a-z]:$/i.test(supplied))
        throw new Error("Use a drive-qualified Windows path, such as C:/Users/name/file, or a workspace-relative path");
      if (win32.isAbsolute(supplied) && /^[a-z]:[\\/]/i.test(supplied))
        return win32.normalize(supplied).replaceAll("\\", "/");
      path = path.replaceAll("\\", "/");
    }
    const absolute = isAbsolute(path) ? posix.normalize(path) : posix.join(remoteCwd, path);
    return local ? remoteCwd + absolute.slice(localRoot.length) : absolute;
  };
  const shell = async (script: string, input?: Buffer, signal?: AbortSignal) =>
    (await run(remote, script, { input, signal, timeoutMs: 600_000 })).stdout;
  const pending = new Map<string, Promise<Buffer>>();
  const fetch = (path: string) => {
    const target = remotePath(path);
    let content = pending.get(target);
    if (!content) {
      content = shell(`cat -- ${sh(target)}`);
      pending.set(target, content);
      const expire = () => {
        if (pending.get(target) === content) pending.delete(target);
      };
      content.then(() => setTimeout(expire, 1000).unref(), expire);
    }
    return content;
  };
  const readFile = async (path: string) => {
    const content = await fetch(path);
    pending.delete(remotePath(path));
    return content;
  };
  const writeFile = async (path: string, content: string | Buffer) => {
    const target = remotePath(path);
    pending.delete(target);
    await shell(`mkdir -p -- ${sh(posix.dirname(target))} && cat > ${sh(target)}`, Buffer.from(content));
  };
  return {
    remotePath,
    read: {
      readFile,
      access: async (path) => void (await fetch(path)),
      detectImageMimeType: async (path) => {
        const head = await fetch(path);
        return imageTypes.find(([, magic]) => magic.every((byte, index) => head[index] === byte))?.[0];
      },
    },
    write: { writeFile, mkdir: async () => {} },
    edit: {
      readFile,
      writeFile,
      access: async (path) => void (await fetch(path)),
    },
    bash: {
      exec: async (command, cwd, { onData, signal, timeout }) => {
        const exit = await runProcess(
          remote.client,
          remote.spaceId,
          { ...shellCommand(remote, `cd ${sh(remotePath(cwd))} && ${command}`), timeoutMs: timeout ? timeout * 1000 : undefined },
          undefined,
          signal,
          (_stream, data) => onData(data),
        );
        if (exit.timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: exit.code };
      },
    },
    find: {
      exists: async (path) => (await run(remote, `test -e ${sh(remotePath(path))}`, { check: false })).exitCode === 0,
      glob: async (pattern, cwd, { limit }) => {
        const root = remotePath(cwd);
        const output = await shell(
          `cd ${sh(root)} && { git ls-files -co --exclude-standard 2>/dev/null || find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | sed 's|^\\./||'; }`,
        );
        const full = pattern.includes("/");
        return output
          .toString("utf8")
          .split("\n")
          .filter((file) => file && posix.matchesGlob(full ? file : posix.basename(file), pattern))
          .slice(0, limit)
          .map((file) => posix.join(cwd, file));
      },
    },
    grep: async (args, cwd, signal) => {
      const root = remotePath(cwd);
      const result = await run(remote, `cd ${sh(root)} && ${args.map(sh).join(" ")}`, { check: false, signal, timeoutMs: 600_000 });
      if (result.exitCode !== 0 && result.exitCode !== 1)
        throw new Error((result.stderr || result.stdout.toString("utf8")).trim().slice(-2000) || `search failed with exit ${result.exitCode}`);
      return result.stdout.toString("utf8");
    },
  };
}
