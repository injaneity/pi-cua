# pi-cua

Run a local pi session's work on a [Cua Space](https://cua.ai/docs), and use every Cua Spaces tool from pi. pi, your extensions, skills, settings and credentials stay on your machine. `read`, `write`, `edit`, `bash`, `find`, `grep` and `!` commands run on the Space, in a copy of your Git workspace. Nothing pi-related is installed there.

```sh
pi install git:github.com/injaneity/pi-cua
```

Signing in and adding your own machines is a one-time step with the `cua` CLI or the Cua Spaces app:

```sh
curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --yes   # on this computer
cua auth login

# on each machine you want to code on (or use the Cua Spaces app's "Add a machine")
curl -fsSL https://cua.ai/install.sh | sh -s -- --only host --yes
```

Then run `/space`. Your machines are listed by name; `/space create` makes a new Space on this computer. There is nothing to configure.

A Space needs `node` and `git`, which the canonical Cua images ship. pi-cua checks for them on entry.

## use

`/space` and the agent's `space` tool take the same argument:

| argument | does |
|---|---|
| _(none)_ | lists Spaces; `/space` opens a picker |
| `<name>` | enters that Space |
| `local` | brings the work back into your checkout and runs locally again |
| `create [name]` | creates a Space on this machine and enters it |
| `delete <name>` | deletes a Space |

Creating and deleting always ask you to confirm, whoever asks. Resume never substitutes a different machine: if the saved Space is gone or reports a different machine identity, pi stops and asks you to choose.

## Cua Spaces tools

Everything the Cua Spaces SDK offers (Spaces, agents, routines, the Cua Volume, sharing, teleport, hotspot and more) is registered as `cua_<tool>`, read from the SDK at startup. They stay out of the prompt until `tool_search` loads them, so they cost no context. Any tool the SDK marks destructive asks you to confirm first, whether you or the agent called it.

## what entering does

```
enter(space)
  1. resolve   online, node and git present, same machine as before
  2. copy      your Git workspace, only the objects the Space is missing
  3. route     read · write · edit · bash · find · grep · ! → the Space
```

- **workspace.** For a Git repository with a network `origin`, pi-cua copies your working tree, including uncommitted and untracked files, into `~/.cua-pi/work/<execution>`. It sends only the Git objects the Space is missing and verifies the full tree before use. If the Space cannot reach `origin`, it starts from a commit snapshot instead. Moving between Spaces transfers objects through your machine; `/space local` applies one tree diff to your checkout, merging non-conflicting local edits. Directories outside Git get a separate empty execution directory and are not synchronized.
- **tools.** pi's own tools run unchanged; only their file and shell operations go to the Space through spacesd. Output streams back, and cancelling kills the command on the Space. Every other tool, such as web search or papercuts, runs on your machine. If another extension replaces one of the six tools, it is blocked while you are on a Space instead of quietly acting on local files.

`/new` and `/fork` inherit the Space with their own copy of the workspace.

## limits

- Linux and macOS Spaces. Windows is not supported.
- Submodules, Git content filters and working-tree encodings are not transferred. Transfers are limited to 200 MiB.
- Sessions on one Space share its user, files and logins. Use a dedicated Space when that matters.
- Workspaces stay on the Space until you return with `/space local`.

## development

```sh
npm test
```

The tests run the real workspace transfer and pi's own tools against local fake Spaces with their own home directories.
