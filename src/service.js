import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, loadConfig } from "./config.js";

const SERVICE_NAME = "Chat2R Machine Client";
const SERVICE_ID = "chat2r-client";
const SERVICE_CONFIG = join(CONFIG_DIR, "service.json");
const SERVICE_LOG = join(CONFIG_DIR, "service.log");
const SERVICE_LAUNCHER = join(CONFIG_DIR, "service-launcher.vbs");
const RUNTIME_DIR = join(CONFIG_DIR, "service-runtime");
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const PACKAGE_ROOT = dirname(PACKAGE_JSON);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function windowsQuote(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function vbString(value) {
  return String(value).replaceAll('"', '""');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `${command} exited with code ${result.status}.`);
  }
  return result;
}

function packageMetadata() {
  return JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
}

function packageVersion() {
  return packageMetadata().version;
}

function packageName() {
  return packageMetadata().name;
}

function runtimePackageDir() {
  const parts = packageName().split("/");
  return join(RUNTIME_DIR, "node_modules", ...parts);
}

function runtimeBin() {
  return join(runtimePackageDir(), "bin", "chat2r.js");
}

function normalizedServiceOptions(options = {}) {
  const config = loadConfig();
  if (!config.credential) {
    throw new Error("This machine is not paired yet. Run chat2r once interactively, pair it, then install the service.");
  }
  const roots = options.roots?.length ? options.roots : [process.cwd()];
  return {
    server: String(options.server || config.serverUrl),
    roots,
    allowShell: options.allowShell !== false
  };
}

function serviceArgs(options) {
  const args = [
    runtimeBin(),
    "--unattended",
    "--no-open",
    "--server",
    options.server,
    "--log-file",
    SERVICE_LOG
  ];
  for (const root of options.roots) args.push("--root", root);
  if (!options.allowShell) args.push("--no-shell");
  return args;
}

function installRuntime() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const npm = platform() === "win32" ? "npm.cmd" : "npm";
  const packed = run(npm, ["pack", PACKAGE_ROOT, "--pack-destination", CONFIG_DIR]);
  const filename = String(packed.stdout || "").trim().split(/\r?\n/u).filter(Boolean).at(-1);
  if (!filename) throw new Error("Could not create the pinned Chat2R service package.");
  const tarball = join(CONFIG_DIR, filename);

  try {
    run(npm, [
      "install",
      "--prefix",
      RUNTIME_DIR,
      tarball,
      "--omit=dev",
      "--no-audit",
      "--no-fund"
    ]);
  } finally {
    rmSync(tarball, { force: true });
  }

  if (!existsSync(runtimeBin())) {
    throw new Error("The Chat2R service runtime was installed, but its CLI entrypoint is missing.");
  }
}

export function buildWindowsLauncher(options, nodePath = process.execPath) {
  const command = [nodePath, ...serviceArgs(options)].map(windowsQuote).join(" ");
  return `Set shell = CreateObject("WScript.Shell")\r\nexitCode = shell.Run("${vbString(command)}", 0, True)\r\nWScript.Quit exitCode\r\n`;
}

export function buildWindowsTaskXml(options, nodePath = process.execPath) {
  const username = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : userInfo().username;
  const wscript = join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const argumentsText = `//B //Nologo ${windowsQuote(SERVICE_LAUNCHER)}`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Chat2R unattended machine client</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(username)}</UserId>
      <Delay>PT3S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(username)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(wscript)}</Command>
      <Arguments>${xml(argumentsText)}</Arguments>
      <WorkingDirectory>${xml(options.roots[0])}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

function windowsTaskFile() {
  return join(CONFIG_DIR, "service-task.xml");
}

function installWindows(options) {
  const taskFile = windowsTaskFile();
  writeFileSync(SERVICE_LAUNCHER, buildWindowsLauncher(options), "utf8");
  writeFileSync(taskFile, "\ufeff" + buildWindowsTaskXml(options), "utf16le");
  run("schtasks.exe", ["/Create", "/TN", SERVICE_NAME, "/XML", taskFile, "/F"]);
  run("schtasks.exe", ["/Run", "/TN", SERVICE_NAME]);
}

function windowsAction(action) {
  if (action === "start") return run("schtasks.exe", ["/Run", "/TN", SERVICE_NAME]).stdout.trim();
  if (action === "stop") return run("schtasks.exe", ["/End", "/TN", SERVICE_NAME], { allowFailure: true }).stdout.trim();
  if (action === "restart") {
    run("schtasks.exe", ["/End", "/TN", SERVICE_NAME], { allowFailure: true });
    return run("schtasks.exe", ["/Run", "/TN", SERVICE_NAME]).stdout.trim();
  }
  if (action === "status") {
    const result = run("schtasks.exe", ["/Query", "/TN", SERVICE_NAME, "/FO", "LIST", "/V"], { allowFailure: true });
    return {
      installed: result.status === 0,
      details: String(result.stdout || result.stderr || "").trim()
    };
  }
  if (action === "uninstall") {
    run("schtasks.exe", ["/End", "/TN", SERVICE_NAME], { allowFailure: true });
    run("schtasks.exe", ["/Delete", "/TN", SERVICE_NAME, "/F"], { allowFailure: true });
    rmSync(windowsTaskFile(), { force: true });
    rmSync(SERVICE_LAUNCHER, { force: true });
    return "Chat2R background task removed.";
  }
  throw new Error(`Unsupported service action: ${action}`);
}

function systemdUnit(options) {
  const args = [process.execPath, ...serviceArgs(options)].map(shellQuote).join(" ");
  return `[Unit]
Description=Chat2R unattended machine client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=5
WorkingDirectory=${options.roots[0]}
StandardOutput=append:${SERVICE_LOG}
StandardError=append:${SERVICE_LOG}

[Install]
WantedBy=default.target
`;
}

function linuxUnitFile() {
  return join(homedir(), ".config", "systemd", "user", `${SERVICE_ID}.service`);
}

function installLinux(options) {
  const unit = linuxUnitFile();
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, systemdUnit(options), "utf8");
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", `${SERVICE_ID}.service`]);
  run("loginctl", ["enable-linger", userInfo().username], { allowFailure: true });
}

function linuxAction(action) {
  if (action === "start") return run("systemctl", ["--user", "start", `${SERVICE_ID}.service`]).stdout.trim();
  if (action === "stop") return run("systemctl", ["--user", "stop", `${SERVICE_ID}.service`]).stdout.trim();
  if (action === "restart") return run("systemctl", ["--user", "restart", `${SERVICE_ID}.service`]).stdout.trim();
  if (action === "status") {
    const result = run("systemctl", ["--user", "status", `${SERVICE_ID}.service`, "--no-pager"], { allowFailure: true });
    return {
      installed: existsSync(linuxUnitFile()),
      details: String(result.stdout || result.stderr || "").trim()
    };
  }
  if (action === "uninstall") {
    run("systemctl", ["--user", "disable", "--now", `${SERVICE_ID}.service`], { allowFailure: true });
    rmSync(linuxUnitFile(), { force: true });
    run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    return "Chat2R user service removed.";
  }
  throw new Error(`Unsupported service action: ${action}`);
}

function plist(options) {
  const args = [process.execPath, ...serviceArgs(options)]
    .map((arg) => `      <string>${xml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.chat2r.client</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${xml(options.roots[0])}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(SERVICE_LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(SERVICE_LOG)}</string>
</dict>
</plist>`;
}

function macPlistFile() {
  return join(homedir(), "Library", "LaunchAgents", "com.chat2r.client.plist");
}

function installMac(options) {
  const file = macPlistFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, plist(options), "utf8");
  run("launchctl", ["bootout", `gui/${process.getuid()}`, file], { allowFailure: true });
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, file]);
  run("launchctl", ["enable", `gui/${process.getuid()}/com.chat2r.client`], { allowFailure: true });
}

function macAction(action) {
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/com.chat2r.client`;
  if (action === "start") return run("launchctl", ["kickstart", target]).stdout.trim();
  if (action === "stop") return run("launchctl", ["kill", "SIGTERM", target], { allowFailure: true }).stdout.trim();
  if (action === "restart") return run("launchctl", ["kickstart", "-k", target]).stdout.trim();
  if (action === "status") {
    const result = run("launchctl", ["print", target], { allowFailure: true });
    return {
      installed: existsSync(macPlistFile()),
      details: String(result.stdout || result.stderr || "").trim()
    };
  }
  if (action === "uninstall") {
    run("launchctl", ["bootout", domain, macPlistFile()], { allowFailure: true });
    rmSync(macPlistFile(), { force: true });
    return "Chat2R LaunchAgent removed.";
  }
  throw new Error(`Unsupported service action: ${action}`);
}

export function serviceStatus() {
  if (platform() === "win32") return windowsAction("status");
  if (platform() === "linux") return linuxAction("status");
  if (platform() === "darwin") return macAction("status");
  throw new Error(`Service management is not supported on ${platform()}.`);
}

export function manageService(action, options = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  if (action === "install") {
    const normalized = normalizedServiceOptions(options);
    installRuntime();
    writeFileSync(SERVICE_CONFIG, JSON.stringify({
      version: packageVersion(),
      installed_at: Date.now(),
      platform: platform(),
      ...normalized
    }, null, 2), { encoding: "utf8", mode: 0o600 });
    if (platform() !== "win32") {
      try {
        chmodSync(SERVICE_CONFIG, 0o600);
      } catch {}
    }

    if (platform() === "win32") installWindows(normalized);
    else if (platform() === "linux") installLinux(normalized);
    else if (platform() === "darwin") installMac(normalized);
    else throw new Error(`Service installation is not supported on ${platform()}.`);

    return {
      installed: true,
      version: packageVersion(),
      log_file: SERVICE_LOG,
      config_file: SERVICE_CONFIG,
      runtime_dir: RUNTIME_DIR
    };
  }

  if (action === "logs") {
    return {
      log_file: SERVICE_LOG,
      content: existsSync(SERVICE_LOG) ? readFileSync(SERVICE_LOG, "utf8") : ""
    };
  }

  let result;
  if (platform() === "win32") result = windowsAction(action);
  else if (platform() === "linux") result = linuxAction(action);
  else if (platform() === "darwin") result = macAction(action);
  else throw new Error(`Service management is not supported on ${platform()}.`);

  if (action === "uninstall") {
    rmSync(SERVICE_CONFIG, { force: true });
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
  }
  return result;
}
