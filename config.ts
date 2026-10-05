import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

const privateFiles = new Set(["auth.json", "models.json", "models-store.json", "trust.json"]);
const privateKeys =
  /^auth$|password|secret|credential|authorization|apikey|privatekey|cookie|token$/i;
const controllerSettings = new Set([
  "packages",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "defaultProjectTrust",
  "bashCommandPrefix",
  "shellPath",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "compaction",
  "enabledModels",
]);
const skippedParts = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache"]);
const omit = Symbol("omit");

export type RuntimeInputs = {
  agentDir: string;
  piVersion: string;
  packages: readonly string[];
  toolFiles: readonly string[];
  skillFiles: readonly string[];
  hostFiles: Record<string, Buffer>;
  documentationRoot?: string;
  projectDir?: string;
};

export type Runtime = {
  hash: string;
  bundle: Buffer;
  paths: Record<string, string>;
  warnings: string[];
};

function isRelativeTo(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    out.push(path);
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) out.push(...walk(path));
  }
  return out;
}

export function portableConfig(
  agentDir: string,
  skillFiles: readonly string[] = [],
  documentationRoot?: string,
  projectDir?: string,
): { files: Map<string, Buffer>; executables: string[]; paths: Record<string, string>; warnings: string[] } {
  const files = new Map<string, Buffer>();
  const paths: Record<string, string> = {};
  const warnings: string[] = [];
  const executables: string[] = [];
  let total = 0;

  const count = (size: number) => {
    total += size;
    if (total > 64 * 1024 * 1024) throw new Error("portable Pi configuration exceeds 64 MiB");
  };

  const scrub = (value: unknown, location: string): unknown => {
    if (Array.isArray(value))
      return value.map((item) => scrub(item, location)).filter((item) => item !== omit);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (privateKeys.test(key.replace(/[^a-zA-Z]/g, ""))) {
          warnings.push(`controller-only credential setting: ${location}.${key}`);
          continue;
        }
        const cleaned = scrub(item, `${location}.${key}`);
        if (cleaned !== omit) result[key] = cleaned;
      }
      return result;
    }
    if (typeof value === "string") {
      if (value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(value)) {
        warnings.push(`controller-only absolute path setting: ${location}`);
        return omit;
      }
      if (
        /-----BEGIN .*PRIVATE KEY-----|\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}|:\/\/[^/\s:@]+:[^/\s@]+@|[?&](?:api[_-]?key|token|secret|password)=/i.test(
          value,
        )
      ) {
        warnings.push(`controller-only credential value: ${location}`);
        return omit;
      }
    }
    return value;
  };

  const add = (source: string, destination: string): boolean => {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warnings.push(`not transferred: non-regular file ${source}`);
      return false;
    }
    if (stat.size > 8 * 1024 * 1024) {
      warnings.push(`not transferred: file exceeds 8 MiB: ${source}`);
      return false;
    }
    let data = readFileSync(source);
    if (/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/.test(data.toString("latin1"))) {
      warnings.push(`not transferred: private key material in ${source}`);
      return false;
    }
    if (extname(source) === ".json") {
      let cleaned: unknown;
      try {
        cleaned = scrub(JSON.parse(data.toString("utf8")), source);
      } catch {
        warnings.push(`not transferred: invalid JSON resource ${source}`);
        return false;
      }
      if (cleaned === omit) return false;
      data = Buffer.from(`${JSON.stringify(cleaned, null, 2)}\n`);
    }
    count(data.length);
    files.set(destination, data);
    if (stat.mode & 0o111) executables.push(destination);
    return true;
  };

  const merge = (base: unknown, update: unknown): unknown => {
    if (!base || typeof base !== "object" || Array.isArray(base) || !update || typeof update !== "object" || Array.isArray(update))
      return update;
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(update)) result[key] = merge(result[key], value);
    return result;
  };

  const configuredSkills: string[] = [];
  const configRoots = [agentDir, ...(projectDir ? [join(projectDir, ".pi")] : [])];
  for (const root of configRoots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root).filter((item) => item.endsWith(".json")).sort()) {
      const source = join(root, name);
      if (privateFiles.has(name) || privateKeys.test(basename(name, ".json"))) {
        warnings.push(`controller-only file: ${name}`);
        continue;
      }
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) {
        warnings.push(`not transferred: symlink ${source}`);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > 1024 * 1024) {
        warnings.push(`not transferred: JSON exceeds 1 MiB: ${name}`);
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(source, "utf8"));
      } catch (error) {
        throw new Error(`invalid Pi configuration: ${source}`, { cause: error });
      }
      if (name === "settings.json") {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Pi settings.json must contain an object");
        const settings = value as Record<string, unknown>;
        for (const item of Array.isArray(settings.skills) ? settings.skills : []) {
          if (typeof item !== "string" || /[!*?{}]/.test(item)) continue;
          const expanded = item.startsWith("~/") ? join(homedir(), item.slice(2)) : item;
          const path = isAbsolute(expanded) ? expanded : resolve(root, expanded);
          if (existsSync(path)) configuredSkills.push(path);
          else warnings.push(`configured skill path unavailable: ${path}`);
        }
        value = Object.fromEntries(Object.entries(settings).filter(([key]) => !controllerSettings.has(key)));
        for (const key of Object.keys(settings).filter((key) => controllerSettings.has(key)).sort())
          warnings.push(`controller setting adapted or kept local: settings.json.${key}`);
      }
      const cleaned = scrub(value, name);
      if (cleaned === omit) continue;
      const previous = files.has(name) ? JSON.parse(files.get(name)!.toString("utf8")) : {};
      const data = Buffer.from(`${JSON.stringify(merge(previous, cleaned), null, 2)}\n`);
      count(data.length);
      files.set(name, data);
      paths[source] = name;
    }
  }

  const roots: Array<[string, string]> = [
    [join(agentDir, "skills"), "skills/global"],
    [join(dirname(dirname(agentDir)), ".agents", "skills"), "skills/shared"],
  ];
  if (projectDir)
    roots.push(
      [join(projectDir, ".pi", "skills"), "skills/project"],
      [join(projectDir, ".agents", "skills"), "skills/project-shared"],
    );
  for (const entry of [...skillFiles, ...configuredSkills]) {
    const source = entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : entry;
    const stat = existsSync(source) ? lstatSync(source) : undefined;
    if (!isAbsolute(source) || !stat || (stat.isSymbolicLink() && !statSync(source).isDirectory()))
      throw new Error(`invalid declared skill file: ${entry}`);
    if (source === realpathSync(source) && roots.some(([root]) => isRelativeTo(source, root))) continue;
    const alias = statSync(source).isDirectory() ? source : dirname(source);
    const root = realpathSync(alias);
    let destination = roots.find(([previous]) => previous === root)?.[1];
    if (!destination) {
      destination = `skills/declared-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
      roots.push([root, destination]);
    }
    paths[alias] = destination;
  }

  const skillRoots: string[] = [];
  const extraRoots: Array<[string, string]> = ["themes", "prompts", "config", "configs"].map((name) => [join(agentDir, name), name]);
  if (documentationRoot) {
    for (const name of ["docs", "examples"]) extraRoots.push([join(documentationRoot, name), `resources/pi/${name}`]);
    const readme = join(documentationRoot, "README.md");
    if (existsSync(readme) && statSync(readme).isFile() && add(readme, "resources/pi/README.md"))
      paths[readme] = "resources/pi/README.md";
  }
  for (const [root, destination] of [...roots, ...extraRoots]) {
    if (!existsSync(root)) continue;
    if (lstatSync(root).isSymbolicLink()) {
      warnings.push(`not transferred: symlink skill directory ${root}`);
      continue;
    }
    paths[root] = destination;
    if (roots.some(([path, value]) => path === root && value === destination)) skillRoots.push(`./${destination}`);
    for (const source of walk(root)) {
      const rel = relative(root, source);
      if (rel.split(sep).some((part) => skippedParts.has(part))) continue;
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) {
        const target = existsSync(source) ? realpathSync(source) : undefined;
        const declared = roots.find(([previous]) => previous === target)?.[1];
        if (declared) paths[source] = declared;
        else if (!(source in paths)) warnings.push(`not transferred: symlink ${source}`);
        continue;
      }
      if (!stat.isFile()) continue;
      const name = basename(source);
      if (privateFiles.has(name) || name.startsWith(".env") || [".pem", ".key", ".p12", ".pfx"].includes(extname(name))) {
        warnings.push(`controller-only skill file: ${source}`);
        continue;
      }
      add(source, `${destination}/${rel.split(sep).join("/")}`);
    }
  }

  const finalSettings = files.has("settings.json") ? JSON.parse(files.get("settings.json")!.toString("utf8")) : {};
  finalSettings.skills = skillRoots;
  files.set("settings.json", Buffer.from(`${JSON.stringify(finalSettings, null, 2)}\n`));
  return { files, executables: executables.sort(), paths, warnings };
}

export function buildRuntime(inputs: RuntimeInputs): Runtime {
  const { files, executables, paths, warnings } = portableConfig(
    inputs.agentDir,
    inputs.skillFiles,
    inputs.documentationRoot,
    inputs.projectDir,
  );
  const extensions = realpathSync(join(inputs.agentDir, "extensions"));
  for (const value of inputs.toolFiles) {
    const resolved = realpathSync(value);
    if (lstatSync(value).isSymbolicLink() || !statSync(resolved).isFile() || !isRelativeTo(resolved, extensions))
      throw new Error(`tool file is outside the user extension directory: ${value}`);
    files.set(relative(realpathSync(inputs.agentDir), resolved).split(sep).join("/"), readFileSync(resolved));
  }
  for (const [name, content] of Object.entries(inputs.hostFiles)) files.set(name, content);
  const settings = JSON.parse(files.get("settings.json")!.toString("utf8"));
  settings.packages = [...inputs.packages];
  files.set("settings.json", Buffer.from(`${JSON.stringify(settings, null, 2)}\n`));
  files.set("cua-runtime.json", Buffer.from(`${JSON.stringify({ piVersion: inputs.piVersion, protocol: 4 })}\n`));

  const sorted = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256");
  for (const [path, content] of sorted) {
    digest.update(path);
    digest.update(content);
  }
  const bundle = gzipSync(
    Buffer.from(
      JSON.stringify({
        files: Object.fromEntries(sorted.map(([path, content]) => [path, content.toString("base64")])),
        executables,
      }),
    ),
  );
  return { hash: digest.digest("hex").slice(0, 20), bundle, paths, warnings };
}
