#!/usr/bin/env node

import { resolve } from "node:path";
import { Chat2rClient } from "../src/client.js";
import { manageService } from "../src/service.js";

const rawArgs = process.argv.slice(2);
const serviceMode = rawArgs[0] === "service";
const serviceAction = serviceMode ? (rawArgs[1] || "status") : null;
const args = serviceMode ? rawArgs.slice(2) : rawArgs;
const options = {
  server: process.env.CHAT2R_SERVER || process.env.CHAT2U_SERVER || undefined,
  roots: [],
  unattended: false,
  allowShell: true,
  noOpen: false,
  logFile: null
};

function valueAfter(index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`Missing value after ${flag}`);
    process.exit(2);
  }
  return value;
}

for (let index = 0; index < args.length; index++) {
  const arg = args[index];

  if (arg === "--server" || arg === "-s") {
    options.server = valueAfter(index, arg);
    index++;
    continue;
  }

  if (arg.startsWith("--server=")) {
    options.server = arg.slice("--server=".length);
    continue;
  }

  if (arg === "--root" || arg === "-r") {
    options.roots.push(resolve(valueAfter(index, arg)));
    index++;
    continue;
  }

  if (arg.startsWith("--root=")) {
    options.roots.push(resolve(arg.slice("--root=".length)));
    continue;
  }

  if (arg === "--allow-shell") {
    options.allowShell = true;
    continue;
  }

  if (arg === "--no-shell") {
    options.allowShell = false;
    continue;
  }

  if (arg === "--unattended" || arg === "-u") {
    options.unattended = true;
    continue;
  }

  if (arg === "--no-open") {
    options.noOpen = true;
    continue;
  }

  if (arg === "--log-file") {
    options.logFile = resolve(valueAfter(index, arg));
    index++;
    continue;
  }

  if (arg.startsWith("--log-file=")) {
    options.logFile = resolve(arg.slice("--log-file=".length));
    continue;
  }

  if (arg === "--help" || arg === "-h") {
    console.log(`
Chat2R 2.0

Usage:
  chat2r [options]
  chat2r service <install|start|stop|restart|status|logs|uninstall> [options]

Options:
  -s, --server <url>       Relay URL. Defaults to saved config or https://chat2r.ender.com.pl.
  -r, --root <path>        Share a filesystem root. Repeat to share multiple roots.
                           Defaults to the current working directory.
      --allow-shell        Explicitly enable exec_command (enabled by default; compatibility flag).
      --no-shell           Disable shell command execution entirely.
  -u, --unattended         Daemon-friendly mode: no stdin/browser prompts, reconnects indefinitely.
      --no-open            Do not automatically open the pairing page.
      --log-file <path>    Append plain-text client logs to a file.
  -h, --help               Show this help.

Examples:
  chat2r --root .
  chat2r --root C:\\Projects --root D:\\Scratch
  chat2r service install --root C:\\Projects
  chat2r service status
`);
    process.exit(0);
  }

  console.error(`Unknown option: ${arg}`);
  process.exit(2);
}

if (!options.roots.length) options.roots.push(process.cwd());

if (serviceMode) {
  const allowed = new Set(["install", "start", "stop", "restart", "status", "logs", "uninstall"]);
  if (!allowed.has(serviceAction)) {
    console.error(`Unknown service action: ${serviceAction}`);
    process.exit(2);
  }
  try {
    const result = manageService(serviceAction, options);
    if (typeof result === "string") console.log(result);
    else if (serviceAction === "logs") {
      console.log(`Log: ${result.log_file}`);
      process.stdout.write(result.content || "");
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    process.exit(0);
  } catch (error) {
    console.error(`Chat2R service error: ${error.message}`);
    process.exit(1);
  }
}

const client = new Chat2rClient(options);

process.on("SIGINT", () => {
  client.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  client.stop();
  process.exit(0);
});

client.start().catch((error) => {
  console.error(`Fatal Chat2R CLI error: ${error.message}`);
  process.exit(1);
});
