# Chat2R

Chat2R connects your computer to the hosted Chat2R relay so ChatGPT can work with files, terminals, Git, background processes, and browser sessions after you approve access.

## Run

```bash
npx chat2r --root .
```

The default relay is:

```text
https://chat2r.ender.com.pl
```

On first launch, Chat2R opens a browser so you can sign in and pair the machine.

## Common options

```bash
chat2r --root C:\Projects
chat2r --root C:\Projects --root D:\Scratch
chat2r --root . --no-shell
chat2r --root . --unattended
chat2r --server https://chat2r.ender.com.pl --root .
```

Use `--server` or `CHAT2R_SERVER` to override the relay URL.

## Security

Only paths under the roots you explicitly share are exposed to Chat2R. Shell execution can be disabled with `--no-shell`. Machine access is separately approved per ChatGPT conversation unless you deliberately configure a more permissive local mode.

This npm package contains the local Chat2R client. The hosted Chat2R backend is not included in the package and remains proprietary.
