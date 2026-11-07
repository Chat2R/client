# Chat2R

Chat2R connects your computer to the hosted Chat2R relay so ChatGPT can work with files, terminals, Git, background processes, and browser sessions after you approve access.

## Quick start

No global install is required:

```bash
npx chat2r@latest --root .
```

The default relay is:

```text
https://chat2r.ender.com.pl
```

On first launch, Chat2R opens a browser so you can sign in and pair the machine.

If you prefer a normal `chat2r` command on PATH, install it globally:

```bash
npm install -g chat2r
chat2r --root .
```

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

Pair the machine once interactively first. Then install the persistent background client:

### Windows

```powershell
npx chat2r@latest service install --root C:\Projects
```

Multiple roots are supported:

```powershell
npx chat2r@latest service install --root C:\Projects --root D:\Scratch
```

Windows uses a hidden Task Scheduler job and a no-window launcher. The client starts at login and Task Scheduler restarts it after failures.

### Linux

```bash
npx chat2r@latest service install --root ~/src
```

Linux uses a systemd user service and attempts to enable user lingering so it can keep running without an active terminal session.

### macOS

```bash
npx chat2r@latest service install --root ~/src
```

macOS uses a LaunchAgent.

The service installer keeps a pinned runtime under `~/.chat2r/service-runtime`. It does not depend on the npm/npx cache after installation.

## Manage the service

You do not need Chat2R installed globally. Use `npx chat2r@latest`:

```bash
npx chat2r@latest service status
npx chat2r@latest service logs
npx chat2r@latest service restart
npx chat2r@latest service stop
npx chat2r@latest service start
```

## Uninstall the service

This stops the background client, removes the OS service/task, and removes the pinned service runtime:

```bash
npx chat2r@latest service uninstall
```

It intentionally keeps `~/.chat2r/config.json`, including the machine pairing credential. That means you can reinstall the service later without pairing again.

If npm is unavailable but the service runtime still exists, you can invoke that runtime directly.

### Windows fallback

```cmd
node "%USERPROFILE%\.chat2r\service-runtime\node_modules\chat2r\bin\chat2r.js" service uninstall
```

### Linux / macOS fallback

```bash
node ~/.chat2r/service-runtime/node_modules/chat2r/bin/chat2r.js service uninstall
```

If you want to remove the saved machine pairing too, uninstall/stop the service first and then remove `~/.chat2r/config.json`, or disconnect the machine from the Chat2R dashboard.

## Logs and files

Service files live under `~/.chat2r/`:

- `config.json` — paired machine credential and client config.
- `service.json` — service installation settings.
- `service.log` — unattended client log.
- `service-runtime/` — pinned npm runtime used by the service.
- Windows additionally uses `service-task.xml` and `service-launcher.vbs`.

View service logs with:

```bash
npx chat2r@latest service logs
```

## Updating the service

Installing again with the latest CLI replaces the pinned runtime and service definition:

```bash
npx chat2r@latest service install --root C:\Projects
```

Use the same roots and shell policy you want the service to expose.

## Security

Only paths under the roots you explicitly share are exposed to Chat2R file tools. Shell execution can be disabled with `--no-shell`. Machine access is separately approved per ChatGPT conversation unless you deliberately configure a more permissive local mode.

This npm package contains the local Chat2R client. The hosted Chat2R backend is not included in the package and remains proprietary.

## Releases and package registries

The public end-user package remains `chat2r` on npmjs, so normal users can run:

```bash
npx chat2r@latest --root .
```

Each version tag (`vX.Y.Z`) is released by GitHub Actions. The same client is also mirrored to GitHub Packages as `@chat2r/client` for GitHub-authenticated environments. GitHub Packages is a mirror, not the default public install path, because GitHub's npm registry requires scoped package names and registry authentication.

For maintainers, npmjs publishing uses npm Trusted Publishing/OIDC from `.github/workflows/release.yml`. No long-lived npm publish token is required. After the npm package trusts the `Chat2R/client` repository and `release.yml` workflow, set the repository variable `NPMJS_TRUSTED_PUBLISHING=true`.
