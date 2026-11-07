import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve
} from "node:path";
import { arch, cpus, freemem, hostname, platform, totalmem, uptime } from "node:os";
import fg from "fast-glob";
import { chromium } from "playwright";
import { computeUnifiedDiff } from "@chat2r/shared";

const DEFAULT_MAX_TEXT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 384 * 1024;
const DEFAULT_COMMAND_YIELD_MS = 10000;
const MAX_COMMAND_YIELD_MS = 60000;
const MAX_COMMAND_RUNTIME_MS = 24 * 60 * 60 * 1000;
const COMMAND_RETENTION_MS = 30 * 60 * 1000;
const MAX_TRACKED_COMMANDS = 100;
const IGNORED_DIRS = ["node_modules", ".git", ".svn", ".hg", ".cache"];

function containment(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeExistingRoot(root) {
  const absolute = resolve(root);
  if (!existsSync(absolute)) throw new Error(`Shared root does not exist: ${absolute}`);
  if (!statSync(absolute).isDirectory()) throw new Error(`Shared root is not a directory: ${absolute}`);
  return realpathSync.native(absolute);
}

function nearestExistingAncestor(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function countBytes(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function truncateOutput(value, maxBytes) {
  const text = String(value);
  if (countBytes(text) <= maxBytes) return text;
  const buffer = Buffer.from(text, "utf8");
  return buffer.subarray(0, maxBytes).toString("utf8") + "\n[output truncated]";
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}

export class RootedExecutor {
  constructor({
    roots,
    allowShell = true,
    maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
  }) {
    if (!Array.isArray(roots) || roots.length === 0) {
      throw new Error("At least one shared root is required.");
    }

    this.roots = [...new Set(roots.map(normalizeExistingRoot))];
    this.allowShell = Boolean(allowShell);
    this.maxTextBytes = maxTextBytes;
    this.maxOutputBytes = maxOutputBytes;
    this.commands = new Map();
    this.browserSessions = new Map();
  }

  resolveLexical(input = ".") {
    const raw = String(input || ".");
    const candidate = isAbsolute(raw)
      ? resolve(raw)
      : resolve(this.roots[0], raw);

    const root = this.roots.find((item) => containment(item, candidate));
    if (!root) {
      throw new Error(`Path is outside the shared roots: ${raw}`);
    }

    return { candidate, root };
  }

  resolveExisting(input = ".") {
    const { candidate, root } = this.resolveLexical(input);
    if (!existsSync(candidate)) throw new Error(`Path does not exist: ${input}`);

    const actual = realpathSync.native(candidate);
    if (!containment(root, actual)) {
      throw new Error(`Symlink or junction escapes the shared root: ${input}`);
    }

    return { path: actual, root };
  }

  resolveWritable(input) {
    const { candidate, root } = this.resolveLexical(input);
    const ancestor = nearestExistingAncestor(candidate);
    if (!ancestor) throw new Error(`Cannot resolve parent path: ${input}`);

    const actualAncestor = realpathSync.native(ancestor);
    if (!containment(root, actualAncestor)) {
      throw new Error(`Parent path escapes the shared root: ${input}`);
    }

    if (existsSync(candidate)) {
      const actual = realpathSync.native(candidate);
      if (!containment(root, actual)) {
        throw new Error(`Symlink or junction escapes the shared root: ${input}`);
      }
      return { path: actual, root };
    }

    return { path: candidate, root };
  }

  relativeDisplay(path) {
    for (const root of this.roots) {
      if (containment(root, path)) {
        return relative(root, path) || ".";
      }
    }
    return path;
  }

  readFile({ file_path, offset = 1, limit = 2000 }) {
    const { path } = this.resolveExisting(file_path);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`Not a file: ${file_path}`);
    if (stat.size > this.maxTextBytes) {
      throw new Error(`File exceeds the ${Math.round(this.maxTextBytes / 1024 / 1024)} MiB text limit.`);
    }

    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = Math.max(0, Number(offset) - 1);
    const end = Math.min(lines.length, start + Math.min(Math.max(Number(limit), 1), 5000));

    const selected = lines.slice(start, end)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n");
    const content = truncateOutput(selected, this.maxOutputBytes);

    return {
      content,
      lines_count: lines.length,
      start_line: start + 1,
      end_line: end,
      has_more: end < lines.length || content !== selected,
      file_path: this.relativeDisplay(path)
    };
  }

  writeFile({ file_path, content }) {
    if (countBytes(content) > this.maxTextBytes) {
      throw new Error(`Content exceeds the ${Math.round(this.maxTextBytes / 1024 / 1024)} MiB write limit.`);
    }

    const { path } = this.resolveWritable(file_path);
    if (existsSync(path)) {
      const oldStat = statSync(path);
      if (!oldStat.isFile()) throw new Error(`Not a file: ${file_path}`);
      if (oldStat.size > this.maxTextBytes) {
        throw new Error("Existing file is too large for text replacement.");
      }
    }

    const oldContent = existsSync(path) ? readFileSync(path, "utf8") : "";
    const diff = computeUnifiedDiff(oldContent, content, this.relativeDisplay(path));

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");

    return {
      success: true,
      bytes_written: countBytes(content),
      file_path: this.relativeDisplay(path),
      diff: {
        loc_added: diff.locAdded,
        loc_removed: diff.locRemoved,
        patch: truncateOutput(diff.patch, this.maxOutputBytes)
      }
    };
  }

  editFile({ file_path, old_string, new_string, replace_all = false }) {
    const { path } = this.resolveExisting(file_path);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`Not a file: ${file_path}`);
    if (stat.size > this.maxTextBytes) throw new Error("File is too large for text editing.");

    const content = readFileSync(path, "utf8");
    const occurrences = content.split(old_string).length - 1;
    if (occurrences === 0) throw new Error(`old_string not found in ${file_path}.`);
    if (!replace_all && occurrences !== 1) {
      throw new Error(`old_string occurs ${occurrences} times. Include more context or set replace_all=true.`);
    }

    const updated = replace_all
      ? content.split(old_string).join(new_string)
      : content.replace(old_string, new_string);

    if (countBytes(updated) > this.maxTextBytes) throw new Error("Edited file would exceed the text size limit.");

    const displayPath = this.relativeDisplay(path);
    const diff = computeUnifiedDiff(content, updated, displayPath);
    writeFileSync(path, updated, "utf8");

    return {
      success: true,
      replacements: replace_all ? occurrences : 1,
      file_path: displayPath,
      diff: {
        loc_added: diff.locAdded,
        loc_removed: diff.locRemoved,
        patch: truncateOutput(diff.patch, this.maxOutputBytes)
      }
    };
  }

  deleteFile({ file_path, recursive = false }) {
    const { path } = this.resolveExisting(file_path);
    if (this.roots.includes(path)) throw new Error("A shared root itself cannot be deleted.");

    const stat = lstatSync(path);
    if (stat.isDirectory() && !recursive) {
      throw new Error("Directory deletion requires recursive=true.");
    }

    rmSync(path, {
      recursive: stat.isDirectory(),
      force: false
    });

    return {
      success: true,
      deleted_path: this.relativeDisplay(path)
    };
  }

  async listDir({ dir_path = ".", pattern = null, max_results = 300 }) {
    const { path } = this.resolveExisting(dir_path);
    if (!statSync(path).isDirectory()) throw new Error(`Not a directory: ${dir_path}`);

    const limit = Math.min(Math.max(Number(max_results || 300), 1), 500);
    const glob = pattern || "**/*";
    const stream = fg.stream(glob, {
      cwd: path,
      dot: true,
      onlyFiles: false,
      followSymbolicLinks: false,
      markDirectories: true,
      unique: true,
      ignore: IGNORED_DIRS.map((name) => `**/${name}/**`)
    });

    const files = [];
    let payloadBytes = 0;
    let truncated = false;

    for await (const rawEntry of stream) {
      const entry = String(rawEntry);
      const candidate = resolve(path, entry.replace(/[\\/]$/, ""));
      if (!containment(path, candidate)) continue;

      const clippedPath = entry.slice(0, 4096);
      const nextBytes = countBytes(clippedPath) + 16;
      if (files.length >= limit || payloadBytes + nextBytes > 256 * 1024) {
        truncated = true;
        stream.destroy?.();
        break;
      }

      payloadBytes += nextBytes;
      files.push({
        path: clippedPath,
        isDirectory: entry.endsWith("/") || entry.endsWith("\\")
      });
    }

    return {
      files,
      count: files.length,
      truncated
    };
  }

  async grepSearch({ pattern, path: input = ".", include = null, max_results = 100 }) {
    const { path } = this.resolveExisting(input);
    const limit = Math.min(Math.max(Number(max_results || 100), 1), 300);

    let regex;
    try {
      regex = new RegExp(pattern, "i");
    } catch (error) {
      throw new Error(`Invalid regular expression: ${error.message}`);
    }

    const matches = [];
    let payloadBytes = 0;
    let truncated = false;

    const inspectFile = (full) => {
      if (matches.length >= limit || payloadBytes >= 512 * 1024) return false;

      let actual;
      try {
        actual = realpathSync.native(full);
      } catch {
        return true;
      }

      const owningRoot = this.roots.find((root) => containment(root, actual));
      if (!owningRoot) return true;

      const fileStat = statSync(actual);
      if (!fileStat.isFile() || fileStat.size > this.maxTextBytes) return true;

      let text;
      try {
        text = readFileSync(actual, "utf8");
      } catch {
        return true;
      }

      const displayFile = this.relativeDisplay(actual).slice(0, 2000);
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        regex.lastIndex = 0;
        if (!regex.test(lines[index])) continue;

        const content = lines[index].slice(0, 500);
        const nextBytes = countBytes(displayFile) + countBytes(content) + 48;
        if (matches.length >= limit || payloadBytes + nextBytes > 512 * 1024) {
          truncated = true;
          return false;
        }

        payloadBytes += nextBytes;
        matches.push({
          file: displayFile,
          line: index + 1,
          content
        });
      }

      return true;
    };

    const stat = statSync(path);
    if (stat.isDirectory()) {
      const stream = fg.stream(include || "**/*", {
        cwd: path,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        unique: true,
        ignore: IGNORED_DIRS.map((name) => `**/${name}/**`)
      });

      for await (const rawEntry of stream) {
        if (!inspectFile(resolve(path, String(rawEntry)))) {
          truncated = true;
          stream.destroy?.();
          break;
        }
      }
    } else {
      inspectFile(path);
    }

    return {
      matches,
      count: matches.length,
      truncated: truncated || matches.length >= limit
    };
  }

  statFile({ file_path }) {
    const { path } = this.resolveExisting(file_path);
    const stat = statSync(path);
    return {
      file_path: this.relativeDisplay(path),
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.size,
      modified_at: stat.mtimeMs,
      created_at: stat.birthtimeMs,
      mode: stat.mode,
      readonly: (stat.mode & 0o222) === 0
    };
  }

  makeDir({ dir_path, recursive = true }) {
    const { path } = this.resolveWritable(dir_path);
    mkdirSync(path, { recursive: Boolean(recursive) });
    return {
      success: true,
      dir_path: this.relativeDisplay(path)
    };
  }

  movePath({ source_path, destination_path, overwrite = false }) {
    const { path: source } = this.resolveExisting(source_path);
    const { path: destination } = this.resolveWritable(destination_path);
    if (this.roots.includes(source)) throw new Error("A shared root itself cannot be moved.");
    if (existsSync(destination)) {
      if (!overwrite) throw new Error("Destination already exists.");
      const destinationStat = lstatSync(destination);
      rmSync(destination, { recursive: destinationStat.isDirectory(), force: false });
    }

    mkdirSync(dirname(destination), { recursive: true });
    try {
      renameSync(source, destination);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      const sourceStat = lstatSync(source);
      cpSync(source, destination, { recursive: sourceStat.isDirectory(), dereference: false });
      rmSync(source, { recursive: sourceStat.isDirectory(), force: false });
    }

    return {
      success: true,
      source_path: this.relativeDisplay(source),
      destination_path: this.relativeDisplay(destination)
    };
  }

  copyPath({ source_path, destination_path, overwrite = false }) {
    const { path: source } = this.resolveExisting(source_path);
    const { path: destination } = this.resolveWritable(destination_path);
    if (existsSync(destination) && !overwrite) throw new Error("Destination already exists.");
    mkdirSync(dirname(destination), { recursive: true });
    const sourceStat = lstatSync(source);
    cpSync(source, destination, {
      recursive: sourceStat.isDirectory(),
      dereference: false,
      force: Boolean(overwrite),
      errorOnExist: !overwrite
    });

    return {
      success: true,
      source_path: this.relativeDisplay(source),
      destination_path: this.relativeDisplay(destination)
    };
  }

  applyPatch({ operations }) {
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new Error("At least one patch operation is required.");
    }
    if (operations.length > 100) throw new Error("A patch can contain at most 100 operations.");

    const results = [];
    for (const operation of operations) {
      if (operation.type === "add") {
        results.push({
          type: "add",
          ...this.writeFile({
            file_path: operation.file_path,
            content: String(operation.content ?? "")
          })
        });
        continue;
      }

      if (operation.type === "replace") {
        results.push({
          type: "replace",
          ...this.editFile({
            file_path: operation.file_path,
            old_string: String(operation.old_string ?? ""),
            new_string: String(operation.new_string ?? ""),
            replace_all: Boolean(operation.replace_all)
          })
        });
        continue;
      }

      if (operation.type === "delete") {
        results.push({
          type: "delete",
          ...this.deleteFile({
            file_path: operation.file_path,
            recursive: Boolean(operation.recursive)
          })
        });
        continue;
      }

      throw new Error(`Unsupported patch operation: ${operation.type}`);
    }

    return {
      success: true,
      operations_applied: results.length,
      results
    };
  }

  getSystemInfo({ env_keys = [] } = {}) {
    const sensitive = /token|secret|password|passwd|key|credential|cookie|session|authorization|auth|private|certificate/i;
    const safeEnvironmentNames = new Set([
      "PATH",
      "HOME",
      "USER",
      "USERNAME",
      "USERPROFILE",
      "SHELL",
      "COMSPEC",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TERM",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS"
    ]);
    const requested = Array.isArray(env_keys) ? env_keys.slice(0, 100) : [];
    const environment = {};
    for (const key of requested) {
      const name = String(key);
      const normalized = name.toUpperCase();
      if (sensitive.test(name)) {
        environment[name] = "[redacted]";
      } else if (!safeEnvironmentNames.has(normalized)) {
        environment[name] = "[blocked]";
      } else if (!(name in process.env) && !(normalized in process.env)) {
        environment[name] = null;
      } else {
        environment[name] = String(process.env[name] ?? process.env[normalized]).slice(0, 4096);
      }
    }

    return {
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      node_version: process.version,
      pid: process.pid,
      cpu_count: cpus().length,
      total_memory_bytes: totalmem(),
      free_memory_bytes: freemem(),
      uptime_seconds: uptime(),
      shared_roots: this.roots,
      shell_enabled: this.allowShell,
      environment
    };
  }

  listProcesses({ limit = 100 } = {}) {
    const max = Math.min(Math.max(Number(limit || 100), 1), 500);
    if (process.platform === "win32") {
      const command = [
        "Get-Process",
        "| Sort-Object CPU -Descending",
        `| Select-Object -First ${max} Id,ProcessName,CPU,WorkingSet64`,
        "| ConvertTo-Json -Compress"
      ].join(" ");
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 2 * 1024 * 1024
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(String(result.stderr || "Could not list processes."));
      const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return {
        processes: rows.map((item) => ({
          pid: Number(item.Id),
          name: String(item.ProcessName || ""),
          cpu_seconds: Number(item.CPU || 0),
          memory_bytes: Number(item.WorkingSet64 || 0)
        }))
      };
    }

    const result = spawnSync("ps", ["-eo", "pid=,ppid=,comm=,rss=,%cpu=", "--sort=-%cpu"], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2 * 1024 * 1024
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(String(result.stderr || "Could not list processes."));

    const processes = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, max).map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        parent_pid: Number(match[2]),
        name: match[3],
        memory_bytes: Number(match[4]) * 1024,
        cpu_percent: Number(match[5])
      };
    }).filter(Boolean);

    return { processes };
  }

  readProcessOutput({ command_id, stdout_offset = 0, stderr_offset = 0, max_chars = 65536 }) {
    const record = this.requireCommand(command_id);
    const limit = Math.min(Math.max(Number(max_chars || 65536), 1), 262144);
    const stdoutStart = Math.min(Math.max(Number(stdout_offset || 0), 0), record.stdout.length);
    const stderrStart = Math.min(Math.max(Number(stderr_offset || 0), 0), record.stderr.length);
    const stdout = record.stdout.slice(stdoutStart, stdoutStart + limit);
    const stderr = record.stderr.slice(stderrStart, stderrStart + limit);

    return {
      command_id: record.command_id,
      status: record.status,
      exit_code: record.exit_code,
      output_truncated: Boolean(record.output_truncated),
      stdout: {
        data: stdout,
        next_offset: stdoutStart + stdout.length,
        has_more: stdoutStart + stdout.length < record.stdout.length
      },
      stderr: {
        data: stderr,
        next_offset: stderrStart + stderr.length,
        has_more: stderrStart + stderr.length < record.stderr.length
      }
    };
  }

  commandWorkdir(workdir) {
    const cwd = workdir
      ? this.resolveExisting(workdir).path
      : this.roots[0];

    if (!statSync(cwd).isDirectory()) throw new Error("Command working directory is not a directory.");
    return cwd;
  }

  appendCommandOutput(record, stream, chunk) {
    const key = stream === "stderr" ? "stderr" : "stdout";
    const current = record[key];
    if (countBytes(current) >= this.maxOutputBytes) {
      record.output_truncated = true;
      return;
    }

    const combined = current + String(chunk);
    const clipped = truncateOutput(combined, this.maxOutputBytes);
    if (clipped !== combined) record.output_truncated = true;
    record[key] = clipped;
  }

  pruneCommands() {
    const now = Date.now();
    for (const [id, record] of this.commands) {
      if (record.status === "running" || record.status === "killing") continue;
      if ((record.completed_at || record.started_at) < now - COMMAND_RETENTION_MS) {
        this.commands.delete(id);
      }
    }

    if (this.commands.size <= MAX_TRACKED_COMMANDS) return;
    const removable = [...this.commands.values()]
      .filter((record) => record.status !== "running" && record.status !== "killing")
      .sort((a, b) => (a.completed_at || a.started_at) - (b.completed_at || b.started_at));

    while (this.commands.size > MAX_TRACKED_COMMANDS && removable.length) {
      this.commands.delete(removable.shift().command_id);
    }
  }

  commandSnapshot(record, { includeOutput = true } = {}) {
    const result = {
      command_id: record.command_id,
      pid: record.pid,
      status: record.status,
      command: record.command,
      workdir: record.workdir,
      started_at: record.started_at,
      completed_at: record.completed_at,
      exit_code: record.exit_code,
      signal: record.signal,
      backgrounded: record.status === "running" || record.status === "killing",
      output_truncated: Boolean(record.output_truncated)
    };

    if (includeOutput) {
      result.stdout = record.stdout;
      result.stderr = record.stderr;
    }
    return result;
  }

  requireCommand(commandId) {
    this.pruneCommands();
    const record = this.commands.get(String(commandId || ""));
    if (!record) throw new Error("Background command was not found or has expired from history.");
    return record;
  }

  startCommand({ command, workdir, max_runtime_ms = 0 }, onChunk = null) {
    if (!this.allowShell) {
      throw new Error("Shell execution is disabled. Restart Chat2R without --no-shell to enable it.");
    }

    const text = String(command || "");
    if (!text.trim()) throw new Error("Command is required.");

    const cwd = this.commandWorkdir(workdir);
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "powershell.exe" : (process.env.SHELL || "/bin/sh");
    const shellArgs = isWindows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", text]
      : ["-c", text];

    this.pruneCommands();

    const record = {
      command_id: `cmd_${randomUUID()}`,
      pid: null,
      child: null,
      status: "starting",
      requested_terminal_status: null,
      command: text,
      workdir: this.relativeDisplay(cwd),
      started_at: Date.now(),
      completed_at: null,
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: "",
      output_truncated: false,
      runtime_timer: null,
      done: null
    };

    let resolveDone;
    record.done = new Promise((resolveCommand) => {
      resolveDone = resolveCommand;
    });

    const child = spawn(shell, shellArgs, {
      cwd,
      windowsHide: true,
      detached: !isWindows,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TERM: "dumb"
      }
    });

    record.child = child;
    record.pid = child.pid || null;
    record.status = "running";
    this.commands.set(record.command_id, record);

    child.stdout.on("data", (chunk) => {
      const textChunk = chunk.toString();
      this.appendCommandOutput(record, "stdout", textChunk);
      onChunk?.(textChunk, "stdout");
    });

    child.stderr.on("data", (chunk) => {
      const textChunk = chunk.toString();
      this.appendCommandOutput(record, "stderr", textChunk);
      onChunk?.(textChunk, "stderr");
    });

    child.on("error", (error) => {
      this.appendCommandOutput(record, "stderr", `\nFailed to start shell: ${error.message}`);
      record.status = "failed";
      record.completed_at = Date.now();
      record.exit_code = 1;
      if (record.runtime_timer) clearTimeout(record.runtime_timer);
      resolveDone(this.commandSnapshot(record));
    });

    child.on("close", (code, signal) => {
      if (record.completed_at) return;
      if (record.runtime_timer) clearTimeout(record.runtime_timer);
      record.status = record.requested_terminal_status || "exited";
      record.completed_at = Date.now();
      record.exit_code = code ?? (record.status === "exited" ? 0 : null);
      record.signal = signal || null;
      resolveDone(this.commandSnapshot(record));
    });

    const maxRuntime = Math.min(
      Math.max(Number(max_runtime_ms || 0), 0),
      MAX_COMMAND_RUNTIME_MS
    );
    if (maxRuntime > 0) {
      record.runtime_timer = setTimeout(() => {
        void this.terminateCommand(record, "timed_out");
      }, maxRuntime);
      record.runtime_timer.unref?.();
    }

    return record;
  }

  async execCommand(args, onChunk = null) {
    const legacyYield = args.yield_time_ms ?? args.timeout_ms;
    const yieldMs = Math.min(
      Math.max(Number(legacyYield ?? DEFAULT_COMMAND_YIELD_MS), 100),
      MAX_COMMAND_YIELD_MS
    );

    const record = this.startCommand({
      command: args.command,
      workdir: args.workdir,
      max_runtime_ms: args.max_runtime_ms || 0
    }, onChunk);

    const completed = await Promise.race([
      record.done.then(() => true),
      delay(yieldMs).then(() => false)
    ]);

    if (completed) {
      return this.commandSnapshot(record);
    }

    return {
      ...this.commandSnapshot(record),
      backgrounded: true,
      message: `Command is still running in the background. Use command_id "${record.command_id}" to inspect, send input, or kill it.`
    };
  }

  startBackgroundCommand(args, onChunk = null) {
    const record = this.startCommand(args, onChunk);
    return {
      ...this.commandSnapshot(record),
      backgrounded: true
    };
  }

  async getBackgroundCommand({ command_id, wait_ms = 0 }) {
    const record = this.requireCommand(command_id);
    const waitMs = Math.min(Math.max(Number(wait_ms || 0), 0), 30000);
    if (waitMs > 0 && record.status === "running") {
      await Promise.race([
        record.done,
        delay(waitMs)
      ]);
    }
    return this.commandSnapshot(record);
  }

  listBackgroundCommands({ running_only = false, limit = 50 } = {}) {
    this.pruneCommands();
    const max = Math.min(Math.max(Number(limit || 50), 1), 100);
    const commands = [...this.commands.values()]
      .filter((record) => !running_only || record.status === "running" || record.status === "killing")
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, max)
      .map((record) => this.commandSnapshot(record, { includeOutput: false }));

    return {
      commands,
      count: commands.length
    };
  }

  writeBackgroundInput({ command_id, input, append_newline = true }) {
    const record = this.requireCommand(command_id);
    if (record.status !== "running" || !record.child?.stdin?.writable) {
      throw new Error("Background command is not accepting input.");
    }

    const payload = String(input ?? "") + (append_newline ? "\n" : "");
    record.child.stdin.write(payload);
    return {
      success: true,
      command_id: record.command_id,
      bytes_written: countBytes(payload)
    };
  }

  async terminateCommand(record, terminalStatus = "killed") {
    if (!record || !["running", "killing"].includes(record.status)) {
      return record ? this.commandSnapshot(record) : null;
    }

    record.requested_terminal_status = terminalStatus;
    record.status = "killing";
    if (record.runtime_timer) {
      clearTimeout(record.runtime_timer);
      record.runtime_timer = null;
    }

    const child = record.child;
    if (!child?.pid) {
      record.status = terminalStatus;
      record.completed_at ||= Date.now();
      return this.commandSnapshot(record);
    }

    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      });
      await Promise.race([
        new Promise((resolveKill) => killer.once("close", resolveKill)),
        delay(3000)
      ]);
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {}
      }

      await Promise.race([
        record.done,
        delay(2000)
      ]);

      if (record.status === "killing") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      }
    }

    await Promise.race([
      record.done,
      delay(3000)
    ]);

    if (record.status === "killing") {
      record.status = terminalStatus;
      record.completed_at ||= Date.now();
    }

    return this.commandSnapshot(record);
  }

  async killBackgroundCommand({ command_id }) {
    const record = this.requireCommand(command_id);
    if (!["running", "killing"].includes(record.status)) {
      return {
        success: true,
        already_finished: true,
        ...this.commandSnapshot(record)
      };
    }

    const result = await this.terminateCommand(record, "killed");
    return {
      success: true,
      ...result
    };
  }

  async launchBrowser() {
    const attempts = [
      () => chromium.launch({ headless: true }),
      () => chromium.launch({ headless: true, channel: "chrome" }),
      () => chromium.launch({ headless: true, channel: "msedge" })
    ];

    let lastError = null;
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Could not launch a Chromium browser. Install one with "npx playwright install chromium" or install Chrome/Edge. ${lastError?.message || ""}`.trim());
  }

  async browserSnapshotRecord(record) {
    const page = record.page;
    const title = await page.title();
    const url = page.url();
    const text = truncateOutput(await page.locator("body").innerText().catch(() => ""), 64 * 1024);
    const links = await page.locator("a[href]").evaluateAll((nodes) => nodes.slice(0, 100).map((node) => ({
      text: String(node.innerText || node.textContent || "").trim().slice(0, 300),
      href: node.href
    })));
    const inputs = await page.locator("input, textarea, select, button").evaluateAll((nodes) => nodes.slice(0, 100).map((node, index) => ({
      index,
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute("type") || null,
      name: node.getAttribute("name") || null,
      id: node.id || null,
      placeholder: node.getAttribute("placeholder") || null,
      text: String(node.innerText || node.getAttribute("aria-label") || "").trim().slice(0, 200)
    })));

    record.last_seen = Date.now();
    return {
      browser_id: record.browser_id,
      url,
      title,
      text,
      links,
      interactive_elements: inputs
    };
  }

  requireBrowser(browserId) {
    const record = this.browserSessions.get(String(browserId || ""));
    if (!record) throw new Error("Browser session was not found or has already been closed.");
    return record;
  }

  async browserOpen({ url }) {
    const target = new URL(String(url || ""));
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Browser URLs must use http or https.");

    const browser = await this.launchBrowser();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ignoreHTTPSErrors: false
    });
    const page = await context.newPage();
    const record = {
      browser_id: `brw_${randomUUID()}`,
      browser,
      context,
      page,
      created_at: Date.now(),
      last_seen: Date.now()
    };
    this.browserSessions.set(record.browser_id, record);

    try {
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
      return await this.browserSnapshotRecord(record);
    } catch (error) {
      await browser.close().catch(() => {});
      this.browserSessions.delete(record.browser_id);
      throw error;
    }
  }

  async browserNavigate({ browser_id, url }) {
    const record = this.requireBrowser(browser_id);
    const target = new URL(String(url || ""));
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("Browser URLs must use http or https.");
    await record.page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
    return this.browserSnapshotRecord(record);
  }

  async browserSnapshot({ browser_id }) {
    return this.browserSnapshotRecord(this.requireBrowser(browser_id));
  }

  async browserClick({ browser_id, selector }) {
    const record = this.requireBrowser(browser_id);
    const target = String(selector || "").trim();
    if (!target) throw new Error("A Playwright selector is required.");
    await record.page.locator(target).first().click({ timeout: 15000 });
    await record.page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    return this.browserSnapshotRecord(record);
  }

  async browserType({ browser_id, selector, text, press_enter = false, clear = true }) {
    const record = this.requireBrowser(browser_id);
    const target = String(selector || "").trim();
    if (!target) throw new Error("A Playwright selector is required.");
    const locator = record.page.locator(target).first();
    if (clear) await locator.fill(String(text ?? ""), { timeout: 15000 });
    else await locator.pressSequentially(String(text ?? ""), { timeout: 15000 });
    if (press_enter) {
      await locator.press("Enter");
      await record.page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    }
    return this.browserSnapshotRecord(record);
  }

  async browserClose({ browser_id }) {
    const record = this.requireBrowser(browser_id);
    this.browserSessions.delete(record.browser_id);
    await record.browser.close().catch(() => {});
    return { success: true, browser_id: record.browser_id };
  }

  async shutdown({ killRunning = true } = {}) {
    const browsers = [...this.browserSessions.values()];
    this.browserSessions.clear();
    await Promise.allSettled(browsers.map((record) => record.browser.close()));

    if (!killRunning) return;
    const running = [...this.commands.values()]
      .filter((record) => record.status === "running" || record.status === "killing");

    await Promise.allSettled(
      running.map((record) => this.terminateCommand(record, "killed"))
    );
  }
}

export function createExecutor(options) {
  return new RootedExecutor(options);
}
