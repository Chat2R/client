# Chat2R

Chat2R connects your computer to the hosted Chat2R relay so ChatGPT can work with files, terminals, Git, background processes, and browser sessions after you approve access.

## Quick start

No global install or registry login is required:

```bash
npx chat2r@latest --root .
```

The default relay is:

```text
https://chat2r.ender.com.pl
```

On first launch, Chat2R opens a browser so you can sign in and pair the machine.

## Common options

```bash
npx chat2r@latest --root C:\Projects
npx chat2r@latest --root C:\Projects --root D:\Scratch
npx chat2r@latest --root . --no-shell
npx chat2r@latest --root . --unattended
npx chat2r@latest --server https://chat2r.ender.com.pl --root .
```

Use `--server` or `CHAT2R_SERVER` to override the relay URL.

## What `--unattended` does

`--unattended` is for daemon/service use. It:

- skips local approval prompts,
- never opens a browser,
- does not read from stdin,
- reconnects automatically through relay restarts and network outages,
- uses heartbeat detection to replace dead WebSocket connections,
- stops cleanly when another client intentionally replaces the same machine connection.

Per-chat access approval on the Chat2R server still applies.

## Install as a background service

Pair the machine once interactively first, then install the persistent background client:

```bash
npx chat2r@latest service install --root C:\Projects
```

Multiple roots are supported:

```bash
npx chat2r@latest service install --root C:\Projects --root D:\Scratch
```

The service installer packs the exact client version currently running and pins that copy under `~/.chat2r/service-runtime`. It does not need to download Chat2R again after service installation.

Windows uses a hidden Task Scheduler job, Linux uses a systemd user service, and macOS uses a LaunchAgent.

## Manage the service

```bash
npx chat2r@latest service status
npx chat2r@latest service logs
npx chat2r@latest service restart
npx chat2r@latest service stop
npx chat2r@latest service start
```

## Uninstall the service

```bash
npx chat2r@latest service uninstall
```

Uninstall stops the background client, removes the OS task/service, and deletes the pinned service runtime. It intentionally keeps `~/.chat2r/config.json`, including the machine pairing credential, so you can reinstall later without pairing again.

If npm is unavailable but the pinned runtime still exists:

### Windows

```cmd
node "%USERPROFILE%\.chat2r\service-runtime
ode_modules\chat2rin\chat2r.js" service uninstall
```

### Linux / macOS

```bash
node ~/.chat2r/service-runtime/node_modules/chat2r/bin/chat2r.js service uninstall
```

## Service files

Files live under `~/.chat2r/`:

- `config.json` — paired machine credential and client config.
- `service.json` — service installation settings.
- `service.log` — unattended client log.
- `service-runtime/` — pinned runtime used by the service.
- Windows additionally uses `service-task.xml` and `service-launcher.vbs`.

## Updating

Re-run service install with the latest package:

```bash
npx chat2r@latest service install --root C:\Projects
```

Use the same roots and shell policy you want the service to expose.

## Releases

`Chat2R/client` is the single source repository. Version tags such as `v2.0.7` are verified by GitHub Actions and published to the public npm registry as the unscoped `chat2r` package using npm Trusted Publishing/OIDC. No long-lived npm publish token is stored in GitHub.

## Security

Only paths under the roots you explicitly share are exposed to Chat2R file tools. Shell execution can be disabled with `--no-shell`. Machine access is separately approved per ChatGPT conversation unless you deliberately configure a more permissive local mode.

This npm package contains the local Chat2R client. The hosted Chat2R backend is not included and remains proprietary.
