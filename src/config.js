import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".chat2r");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LEGACY_CONFIG_DIR = join(homedir(), ".chat2u");
const LEGACY_CONFIG_FILE = join(LEGACY_CONFIG_DIR, "config.json");

const DEFAULTS = Object.freeze({
  serverUrl: "http://localhost:8787",
  machineId: null,
  machineName: null,
  credential: null
});

export function loadConfig() {
  try {
    const source = existsSync(CONFIG_FILE)
      ? CONFIG_FILE
      : (existsSync(LEGACY_CONFIG_FILE) ? LEGACY_CONFIG_FILE : null);
    if (!source) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(readFileSync(source, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(updates) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const merged = { ...loadConfig(), ...updates };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });

  if (process.platform !== "win32") {
    try {
      chmodSync(CONFIG_DIR, 0o700);
      chmodSync(CONFIG_FILE, 0o600);
    } catch {}
  }

  return merged;
}

export function clearMachineCredential() {
  return saveConfig({
    machineId: null,
    machineName: null,
    credential: null
  });
}

export { CONFIG_DIR, CONFIG_FILE, LEGACY_CONFIG_DIR, LEGACY_CONFIG_FILE };
