import { arch, hostname, platform } from "node:os";
import open from "open";
import { WebSocket } from "ws";
import {
  makeMessage,
  MSG_TYPES,
  parseMessage
} from "@chat2r/shared";
import {
  clearMachineCredential,
  loadConfig,
  saveConfig
} from "./config.js";
import { createExecutor } from "./executor.js";
import { TerminalUI } from "./ui.js";

export class Chat2rClient {
  constructor(options = {}) {
    this.config = loadConfig();
    this.serverUrl = String(options.server || process.env.CHAT2R_SERVER || process.env.CHAT2U_SERVER || this.config.serverUrl || "http://localhost:8787").replace(/\/$/, "");
    this.unattended = Boolean(options.unattended);
    this.noOpen = Boolean(options.noOpen);
    this.roots = options.roots?.length ? options.roots : [process.cwd()];
    this.allowShell = options.allowShell !== false;
    this.ui = new TerminalUI();
    this.executor = createExecutor({
      roots: this.roots,
      allowShell: this.allowShell
    });
    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.heartbeatTimer = null;
    this.ready = false;
  }

  async start() {
    this.ui.banner();
    this.ui.log(`Server: ${this.serverUrl}`);
    this.ui.log(`Shared roots: ${this.executor.roots.join(", ")}`);

    if (!this.allowShell) {
      this.ui.log("Shell execution is disabled. File tools remain available inside the shared roots.", "info");
    } else {
      this.ui.log("Shell execution is enabled. Commands run with this OS user's privileges.", "warning");
    }

    if (this.unattended) {
      this.ui.log("Unattended mode is enabled: local approval prompts will be skipped.", "warning");
    }

    await this.connect();
  }

  async connect() {
    if (this.stopped) return;

    const wsUrl = new URL(this.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws/machine";
    wsUrl.search = "";

    this.ui.log(`Connecting to ${wsUrl.toString()}`);

    const ws = new WebSocket(wsUrl, {
      maxPayload: 1024 * 1024,
      perMessageDeflate: false
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.ready = false;
      this.ui.log("Connected to relay.", "success");
      this.sendHello();
      this.startHeartbeat();
    });

    ws.on("message", (data) => {
      const message = parseMessage(data);
      if (!message) {
        this.ui.log("Ignored malformed relay message.", "warning");
        return;
      }
      void this.handleServerMessage(message);
    });

    ws.on("close", (code, reason) => {
      this.ready = false;
      this.stopHeartbeat();
      if (this.stopped) return;

      const reasonText = reason?.toString() || "connection closed";
      this.ui.log(`Disconnected (${code}: ${reasonText}).`, "warning");
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      this.ui.log(`WebSocket error: ${error.message}`, "error");
    });
  }

  sendHello() {
    this.send(MSG_TYPES.HELLO, {
      credential: this.config.credential || null,
      machineInfo: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        roots: this.executor.roots
      },
      capabilities: {
        shell: this.allowShell,
        pty: this.allowShell
      }
    });
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send(MSG_TYPES.HEARTBEAT, {});
      }
    }, 20000);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  scheduleReconnect() {
    const attempt = Math.min(this.reconnectAttempt++, 6);
    const delay = Math.min(30000, 1000 * (2 ** attempt));
    this.ui.log(`Reconnecting in ${Math.round(delay / 1000)}s…`);
    const timer = setTimeout(() => void this.connect(), delay);
    timer.unref?.();
  }

  send(type, payload = {}, id) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay is not connected.");
    }
    this.ws.send(makeMessage(type, payload, id));
  }

  async handleServerMessage(message) {
    switch (message.type) {
      case MSG_TYPES.PAIRING_REQUIRED: {
        const { code, pairUrl } = message.payload;
        this.ui.section("Pair this machine");
        this.ui.log(`Pairing code: ${code}`, "warning");
        this.ui.log(`Open: ${pairUrl}`);

        if (!this.noOpen && pairUrl) {
          try {
            await open(pairUrl, { wait: false });
          } catch (error) {
            this.ui.log(`Could not open the browser: ${error.message}`, "warning");
          }
        }
        break;
      }

      case MSG_TYPES.PAIRED: {
        const { machineId, name, credential } = message.payload;
        this.config = saveConfig({
          serverUrl: this.serverUrl,
          machineId,
          machineName: name,
          credential
        });
        this.ready = true;
        this.ui.log(`Paired as "${name}".`, "success");
        this.ui.log("Ready for ChatGPT.", "success");
        break;
      }

      case MSG_TYPES.DEVICE_READY: {
        this.ready = true;
        this.ui.log(`Authenticated as "${message.payload.name || this.config.machineName || "Machine"}".`, "success");
        this.ui.log("Ready for ChatGPT.", "success");
        break;
      }

      case MSG_TYPES.REVOKED: {
        this.config = clearMachineCredential();
        this.ui.log(String(message.payload.message || "Machine credential was revoked."), "warning");
        break;
      }

      case MSG_TYPES.ACTION_REQUEST: {
        await this.handleAction(message.payload);
        break;
      }

      case MSG_TYPES.ERROR: {
        this.ui.log(String(message.payload.message || "Relay error."), "error");
        break;
      }
    }
  }

  approvalDetails(tool, args) {
    if (tool === "exec_command") {
      return `Command: ${args.command}\nWorkdir: ${args.workdir || this.executor.roots[0]}`;
    }
    if (tool === "delete_file") {
      return `Path: ${args.file_path}\nRecursive: ${Boolean(args.recursive)}`;
    }
    if (tool === "write_file" || tool === "edit_file") {
      return `File: ${args.file_path}`;
    }
    if (tool === "read_file" || tool === "stat_file") {
      return `File: ${args.file_path}`;
    }
    if (tool === "move_path" || tool === "copy_path") {
      return `From: ${args.source_path}\nTo: ${args.destination_path}`;
    }
    if (tool === "apply_patch") {
      const operations = Array.isArray(args.operations) ? args.operations : [];
      return operations
        .slice(0, 100)
        .map((operation) => `${operation.type}: ${operation.file_path}`)
        .join("\n")
        .slice(0, 4000);
    }
    return JSON.stringify(args, null, 2).slice(0, 4000);
  }

  async handleAction(payload) {
    const actionId = String(payload.actionId || "");
    const tool = String(payload.tool || "");
    const args = payload.args || {};

    if (!actionId || !tool) return;

    this.ui.log(`${tool} requested`, tool === "exec_command" ? "cmd" : "info");

    if (payload.needsApproval && !this.unattended) {
      const approved = await this.ui.askApproval({
        title: tool,
        details: this.approvalDetails(tool, args),
        actionType: String(payload.mode || "local policy")
      });

      if (!approved) {
        this.send(MSG_TYPES.ACTION_RESULT, {
          actionId,
          success: false,
          error: "Action declined by the machine owner."
        });
        return;
      }
    }

    try {
      let result;
      switch (tool) {
        case "read_file":
          result = this.executor.readFile(args);
          break;
        case "list_dir":
          result = await this.executor.listDir(args);
          break;
        case "grep_search":
          result = await this.executor.grepSearch(args);
          break;
        case "stat_file":
          result = this.executor.statFile(args);
          break;
        case "mkdir":
          result = this.executor.makeDir(args);
          break;
        case "move_path":
          result = this.executor.movePath(args);
          break;
        case "copy_path":
          result = this.executor.copyPath(args);
          break;
        case "apply_patch":
          result = this.executor.applyPatch(args);
          break;
        case "get_system_info":
          result = this.executor.getSystemInfo(args);
          break;
        case "list_processes":
          result = this.executor.listProcesses(args);
          break;
        case "read_process_output":
          result = this.executor.readProcessOutput(args);
          break;
        case "write_file":
          result = this.executor.writeFile(args);
          break;
        case "edit_file":
          result = this.executor.editFile(args);
          break;
        case "delete_file":
          result = this.executor.deleteFile(args);
          break;
        case "exec_command": {
          let streamedBytes = 0;
          const maxStreamBytes = 256 * 1024;
          result = await this.executor.execCommand(args, (chunk, stream) => {
            if (streamedBytes >= maxStreamBytes) return;
            const remaining = maxStreamBytes - streamedBytes;
            const buffer = Buffer.from(String(chunk), "utf8");
            const safeChunk = buffer.subarray(0, Math.min(buffer.length, remaining)).toString("utf8");
            if (!safeChunk) return;

            streamedBytes += Buffer.byteLength(safeChunk, "utf8");
            if (this.ws?.readyState === WebSocket.OPEN) {
              this.send(MSG_TYPES.ACTION_CHUNK, { actionId, stream, chunk: safeChunk });
            }
          });
          break;
        }
        case "start_background_command":
          result = this.executor.startBackgroundCommand(args);
          break;
        case "get_background_command":
          result = await this.executor.getBackgroundCommand(args);
          break;
        case "list_background_commands":
          result = this.executor.listBackgroundCommands(args);
          break;
        case "write_background_input":
          result = this.executor.writeBackgroundInput(args);
          break;
        case "resize_terminal":
          result = this.executor.resizeTerminal(args);
          break;
        case "kill_background_command":
          result = await this.executor.killBackgroundCommand(args);
          break;
        case "browser_open":
          result = await this.executor.browserOpen(args);
          break;
        case "browser_navigate":
          result = await this.executor.browserNavigate(args);
          break;
        case "browser_snapshot":
          result = await this.executor.browserSnapshot(args);
          break;
        case "browser_click":
          result = await this.executor.browserClick(args);
          break;
        case "browser_type":
          result = await this.executor.browserType(args);
          break;
        case "browser_close":
          result = await this.executor.browserClose(args);
          break;
        default:
          throw new Error(`Unsupported machine tool: ${tool}`);
      }

      this.send(MSG_TYPES.ACTION_RESULT, {
        actionId,
        success: true,
        result
      });
      this.ui.log(`${tool} completed.`, "success");
    } catch (error) {
      this.send(MSG_TYPES.ACTION_RESULT, {
        actionId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      this.ui.log(`${tool} failed: ${error.message}`, "error");
    }
  }

  stop() {
    this.stopped = true;
    this.stopHeartbeat();
    void this.executor.shutdown({ killRunning: true });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "client shutdown");
    }
    this.ui.close();
  }
}
