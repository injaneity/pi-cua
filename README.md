# pi-cua

Run a local pi session's tools on a [Cua Space](https://cua.ai/docs). The TUI, agent loop, model credentials and session stay on your machine. Tool calls and `!` commands run on the Space, with the same pi version, extensions and skills, in a copy of your Git workspace.

```sh
pi install git:github.com/injaneity/pi-cua
```

A Space needs `node` 22+, `npm` and `git`. pi-cua checks for them on first entry and installs nothing at the system level.

## use

| action | how |
|---|---|
| choose a Space, reconnect, or go back to local | `/space` |
| enter a Space by name | `/space mac-studio` |
| bring the work back into your checkout | `/space local` |
| create a Space and enter it | `/space create <local\|cloud> [name] [cpus memory_mb]` |
| delete a Space | `/space delete <name>` |
| let the agent move itself | the `enter_space` tool (no arguments lists Spaces) |

The agent can only enter Spaces that already exist. Creating, deleting and returning to local are user actions. Resume never substitutes a different machine: if the saved Space is gone or reports a different machine identity, pi stops and asks you to choose.

## what entering does

```
enter(space)
  1. resolve   online, prerequisites present, same machine as before
  2. set up    pi runtime · workspace · tool host, each only if missing
  3. route     tools → the Space, save placement, retire the previous place
```

- **pi runtime.** `~/.cua-pi/pi/<version>` holds the exact pi version you run locally. `~/.cua-pi/runtimes/<hash>` holds your portable configuration (settings, skills, prompts, themes) and the extension packages your tools come from. The hash covers every file, so an unchanged setup is reused. Credentials, `auth.json`, env files, private keys and absolute-path settings stay local; transfer notes are listed when you enter.
- **workspace.** For a Git repository with a network `origin`, pi-cua copies your working tree, including uncommitted and untracked files, into `~/.cua-pi/work/<execution>`. It sends only the Git objects the Space is missing and verifies the full tree before use. If the Space cannot reach `origin`, it starts from a commit snapshot instead. Moving between Spaces transfers objects through your machine; `/space local` applies one tree diff to your checkout, merging non-conflicting local edits. The source workspace is removed only after the destination has verified its copy. Directories outside Git get a separate empty execution directory and are not synchronized.
- **tool host.** One headless pi per session runs on the Space as a spacesd process, speaking JSON lines over its stdin and stdout. Tool output streams back as it is produced, cancelling kills the command on the Space, and closing pi stops the host. It has no model or conversation.

Tools from `web_search`, `report_papercut` and the papercut ledger stay on your machine. Tools from local-path packages cannot be installed on a Space and are blocked there, never run locally instead. `/new` and `/fork` inherit the Space with their own copy of the workspace.

## limits

- Linux and macOS Spaces. Windows is not supported.
- Submodules, Git content filters and working-tree encodings are not transferred. Transfers are limited to 200 MiB.
- Sessions on one Space share its user, files and logins. Use a dedicated Space when that matters.
- Runtimes and workspaces stay on the Space until removed.

## development

```sh
npm test
```

The tests run the real setup, workspace and relay code against local fake Spaces with their own home directories.
