import readline from "node:readline";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
};

export class TerminalUI {
  constructor({ interactive = true } = {}) {
    this.interactive = Boolean(interactive);
    this.rl = this.interactive
      ? readline.createInterface({
          input: process.stdin,
          output: process.stdout
        })
      : null;
  }

  banner() {
    if (process.stdout.isTTY) console.clear();
    console.log(`${ANSI.bold}Chat2R${ANSI.reset}  ${ANSI.dim}local machine bridge${ANSI.reset}`);
    console.log(`${ANSI.gray}──────────────────────────────────────────────────${ANSI.reset}\n`);
  }

  log(message, type = "info") {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const styles = {
      success: { icon: "✓", color: ANSI.green },
      warning: { icon: "!", color: ANSI.yellow },
      error: { icon: "×", color: ANSI.red },
      cmd: { icon: "›", color: ANSI.cyan },
      info: { icon: "•", color: ANSI.gray }
    };
    const style = styles[type] || styles.info;
    console.log(`${ANSI.gray}${time}${ANSI.reset}  ${style.color}${style.icon}${ANSI.reset} ${message}`);
  }

  section(title) {
    console.log(`\n${ANSI.bold}${title}${ANSI.reset}`);
  }

  prompt(question) {
    if (!this.rl) throw new Error("Interactive prompts are unavailable in unattended mode.");
    return new Promise((resolve) => {
      this.rl.question(question, (answer) => resolve(answer.trim()));
    });
  }

  async askApproval({ title, details, actionType }) {
    this.section("Approval required");
    console.log(`${ANSI.yellow}${title}${ANSI.reset}  ${ANSI.gray}${actionType}${ANSI.reset}`);
    if (details) {
      console.log(`${ANSI.gray}──────────────────────────────────────────────────${ANSI.reset}`);
      console.log(details);
      console.log(`${ANSI.gray}──────────────────────────────────────────────────${ANSI.reset}`);
    }

    const answer = await this.prompt(`${ANSI.bold}Approve? [y/N] ${ANSI.reset}`);
    const approved = ["y", "yes"].includes(answer.toLowerCase());
    this.log(approved ? "Approved" : "Rejected", approved ? "success" : "warning");
    return approved;
  }

  async askAttachPrompt(agentInfo) {
    this.section("Connection request");
    console.log(`Agent   ${ANSI.cyan}${agentInfo?.name || "ChatGPT"}${ANSI.reset}`);
    if (agentInfo?.user) console.log(`Account ${agentInfo.user}`);
    console.log(`${ANSI.dim}This conversation wants to attach to this machine.${ANSI.reset}\n`);

    const answer = await this.prompt(`${ANSI.bold}Allow connection? [y/N] ${ANSI.reset}`);
    return ["y", "yes"].includes(answer.toLowerCase());
  }

  close() {
    this.rl?.close();
  }
}
