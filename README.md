# Chat2R

Chat2R connects your computer to the hosted Chat2R relay so ChatGPT can work with files, terminals, Git, background processes, and browser sessions after you approve access.

## Install / authenticate once

The client is published only through GitHub Packages as `@chat2r/client`.

GitHub requires authentication even for public npm packages. Create a GitHub personal access token (classic) with `read:packages`, then run:

```bash
npm login --scope=@chat2r --auth-type=legacy --registry=https://npm.pkg.github.com
```

Use your GitHub username and the token as the password.

After that, you do not need to install Chat2R globally.

## Quick start

```bash
npm exec --yes --package=@chat2r/client@latest -- chat2r --root .
```

The default relay is:

```text
https://chat2r.ender.com.pl
```

On first launch, Chat2R opens a browser so you can sign in and pair the machine.

## Common options

```bash
npm exec --yes --package=@chat2r/client@latest -- chat2r --root C:\Projects
npm exec --yes --package=@chat2r/client@latest -- chat2r --root C:\Projects --root D:\Scratch
npm exec --yes --package=@chat2r/client@latest -- chat2r --root . --no-shell
npm exec --yes --package=@chat2r/client@latest -- chat2r --root . --unattended
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
npm exec --yes --package=@chat2r/client@latest -- chat2r service install --root C:\Projects
```

Multiple roots are supported:

```bash
npm exec --yes --package=@chat2r/client@latest -- chat2r service install --root C:\Projects --root D:\Scratch
```

The service installer packs the exact client version currently running and pins that copy under `~/.chat2r/service-runtime`. It does not fetch Chat2R from npmjs or depend on the npm exec cache after installation.

Windows uses a hidden Task Scheduler job, Linux uses a systemd user service, and macOS uses a LaunchAgent.

## Manage the service

```bash
npm exec --yes --package=@chat2r/client@latest -- chat2r service status
npm exec --yes --package=@chat2r/client@latest -- chat2r service logs
npm exec --yes --package=@chat2r/client@latest -- chat2r service restart
npm exec --yes --package=@chat2r/client@latest -- chat2r service stop
npm exec --yes --package=@chat2r/client@latest -- chat2r service start
```

## Uninstall the service

```bash
npm exec --yes --package=@chat2r/client@latest -- chat2r service uninstall
```

Uninstall stops the background client, removes the OS task/service, and deletes the pinned service runtime. It intentionally keeps `~/.chat2r/config.json`, including the machine pairing credential, so you can reinstall later without pairing again.

If GitHub Packages/npm is unavailable but the pinned runtime still exists:

### Windows

```cmd
node "%USERPROFILE%\.chat2r\service-runtime\node_modules\@chat2r\client\bin\chat2r.js" service uninstall
```

### Linux / macOS

```bash
node ~/.chat2r/service-runtime/node_modules/@chat2r/client/bin/chat2r.js service uninstall
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
npm exec --yes --package=@chat2r/client@latest -- chat2r service install --root C:\Projects
```

Use the same roots and shell policy you want the service to expose.

## Releases

`Chat2R/client` is the single source repository. Pushing a version tag such as `v2.0.6` runs CI and publishes `@chat2r/client` to GitHub Packages using the repository's `GITHUB_TOKEN`. There is no npmjs publishing step and no npm publish token to manage.

## Security

Only paths under the roots you explicitly share are exposed to Chat2R file tools. Shell execution can be disabled with `--no-shell`. Machine access is separately approved per ChatGPT conversation unless you deliberately configure a more permissive local mode.

This package contains the local Chat2R client. The hosted Chat2R backend is not included and remains proprietary.
