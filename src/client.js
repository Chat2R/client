import { arch, hostname, platform } from "node:os";
import open from "open";
import { WebSocket } from "ws";
import {
  makeMessage,
  MSG_TYPES,
  parseMessage
} from "./protocol.js";
import {
  clearMachineCredential,
  DEFAULT_SERVER_URL,
  loadConfig,
  saveConfig
} from "./config.js";
import { createExecutor } from "./executor.js";
import { TerminalUI } from "./ui.js";

export class Chat2rClient {
  constructor(options = {}) {
    this.config = loadConfig();
    this.serverUrl = String(options.server || process.env.CHAT2R_SERVER || process.env.CHAT2U_SERVER || this.config.serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, "");
    this.unattended = Boolean(options.unattended);
    this.noOpen = Boolean(options.noOpen || this.unattended);
    this.roots = options.roots?.length ? options.roots : [process.cwd()];
    this.allowShell = options.allowShell !== false;
    this.ui = options.ui || new TerminalUI({ interactive: !this.unattended });
    this.executor = options.executor || createExecutor({
      roots: this.roots,
      allowShell: this.allowShell
    });
    this.WebSocketClass = options.WebSocketClass || WebSocket;
    this.random = typeof options.random === "function" ? options.random : Math.random;
    this.reconnectMinMs = Math.max(100, Number(options.reconnectMinMs || 1000));
    this.reconnectMaxMs = Math.max(this.reconnectMinMs, Number(options.reconnectMaxMs || 30000));
    this.connectTimeoutMs = Math.max(1000, Number(options.connectTimeoutMs || 15000));
    this.heartbeatIntervalMs = Math.max(1000, Number(options.heartbeatIntervalMs || 15000));
    this.heartbeatTimeoutMs = Math.max(this.heartbeatIntervalMs * 2, Number(options.heartbeatTimeoutMs || 45000));
    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.heartbeatTimer = null;
    this.lastPongAt = 0;
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
      this.ui.log("Unattended mode: no local approval prompts, browser launch, or stdin interaction; reconnect stays active through relay/network outages.", "warning");
    }

    await this.connect();
  }

  async connect() {
    if (this.stopped) return;
    if (this.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(this.ws.readyState)) return;

    const wsUrl = new URL(this.serverUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    wsUrl.pathname = "/ws/machine";
    wsUrl.search = "";

    this.ui.log(`Connecting to ${wsUrl.toString()}`);

    const ws = new this.WebSocketClass(wsUrl, {
      maxPayload: 1024 * 1024,
      perMessageDeflate: false
    });
    this.ws = ws;
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      this.ui.log("Relay connection attempt timed out; retrying.", "warning");
      ws.terminate();
    }, this.connectTimeoutMs);

    ws.on("open", () => {
      if (this.ws !== ws || this.stopped) return;
      this.clearConnectTimer();
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.ready = false;
      this.lastPongAt = Date.now();
      this.ui.log("Connected to relay.", "success");
      try {
        this.sendHello();
        this.startHeartbeat(ws);
      } catch (error) {
        this.ui.log(`Could not initialize relay session: ${error.message}`, "error");
        ws.terminate();
      }
    });

    ws.on("pong", () => {
      if (this.ws === ws) this.lastPongAt = Date.now();
    });

    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      const message = parseMessage(data);
      if (!message) {
        this.ui.log("Ignored malformed relay message.", "warning");
        return;
      }
      void this.handleServerMessage(message).catch((error) => {
        this.ui.log(`Relay message handling failed: ${error.message}`, "error");
      });
    });

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.clearConnectTimer();
      this.stopHeartbeat();
      if (this.stopped) return;

      const reasonText = reason?.toString() || "connection closed";
      this.ui.log(`Disconnected (${code}: ${reasonText}).`, "warning");
      if (code === 4000 && /replaced/i.test(reasonText)) {
        this.stopped = true;
        this.ui.log("Another Chat2R client took over this machine. This instance will stop instead of reconnecting.", "warning");
        this.ui.close();
        return;
      }
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.ui.log(`WebSocket error: ${error.message}`, "error");
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
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
        pty: this.allowShell,
        git: this.allowShell
      }
    });
  }

  clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  startHeartbeat(ws = this.ws) {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPongAt > this.heartbeatTimeoutMs) {
        this.ui.log("Relay heartbeat timed out; reconnecting.", "warning");
        ws.terminate();
        return;
      }

      try {
        ws.ping();
      } catch (error) {
        this.ui.log(`Relay ping failed: ${error.message}`, "warning");
        ws.terminate();
        return;
      }

      this.trySend(MSG_TYPES.HEARTBEAT, {});
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    const attempt = Math.min(this.reconnectAttempt++, 10);
    const baseDelay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** attempt));
    const jitter = 0.8 + (this.random() * 0.4);
    const delay = Math.max(this.reconnectMinMs, Math.round(baseDelay * jitter));
    this.ui.log(`Reconnecting in ${Math.max(1, Math.round(delay / 1000))}s…`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        this.ui.log(`Reconnect failed: ${error.message}`, "error");
        this.scheduleReconnect();
      });
    }, delay);
  }

  send(type, payload = {}, id) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay is not connected.");
    }
    this.ws.send(makeMessage(type, payload, id));
  }

  trySend(type, payload = {}, id) {
    try {
      this.send(type, payload, id);
      return true;
    } catch {
      return false;
    }
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
        this.reconnectAttempt = 0;
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
        this.reconnectAttempt = 0;
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
    if (tool === "git_commit") {
      const staged = args.stage_all
        ? "all changes"
        : Array.isArray(args.paths) && args.paths.length
          ? args.paths.join(", ")
          : "currently staged changes";
      return `Repository: ${args.workdir || this.executor.roots[0]}\nCommit: ${args.message}\nStage: ${staged}`;
    }
    if (tool === "git_push") {
      return `Repository: ${args.workdir || this.executor.roots[0]}\nRemote: ${args.remote || "origin"}\nBranch: ${args.branch || "current"}`;
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
        this.trySend(MSG_TYPES.ACTION_RESULT, {
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
        case "git_status":
          result = this.executor.gitStatus(args);
          break;
        case "git_diff":
          result = this.executor.gitDiff(args);
          break;
        case "git_log":
          result = this.executor.gitLog(args);
          break;
        case "git_commit":
          result = this.executor.gitCommit(args);
          break;
        case "git_push":
          result = this.executor.gitPush(args);
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
            this.trySend(MSG_TYPES.ACTION_CHUNK, { actionId, stream, chunk: safeChunk });
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

      const delivered = this.trySend(MSG_TYPES.ACTION_RESULT, {
        actionId,
        success: true,
        result
      });
      this.ui.log(
        delivered ? `${tool} completed.` : `${tool} completed while relay was offline; result could not be delivered.`,
        delivered ? "success" : "warning"
      );
    } catch (error) {
      this.trySend(MSG_TYPES.ACTION_RESULT, {
        actionId,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      this.ui.log(`${tool} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectTimer();
    this.stopHeartbeat();
    void this.executor.shutdown({ killRunning: true });
    const ws = this.ws;
    this.ws = null;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close(1000, "client shutdown");
    } else if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
    this.ui.close();
  }
}
