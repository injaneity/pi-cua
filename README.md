<p align="center">
  <a href="https://cua.ai/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/cua-lockup-white.png">
      <img src="assets/cua-lockup-black.png" alt="Cua" width="240">
    </picture>
  </a>
</p>

<h1 align="center">pi-cua</h1>
<p align="center">Your pi coding sessions. Your computers. Cua Spaces.</p>
<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#choose-a-space">Choose a Space</a> ·
  <a href="https://cua.ai/docs/spaces/concepts/how-spaces-works">Cua Spaces docs</a>
</p>

---

## Local pi. Work on a Space.

Cua Spaces gives people and agents shared desktops on computers you own or rent: your computer, another computer you connect, or a VM in your own cloud account. A Space can be a container, a virtual machine, or a computer's own desktop—not a Cua-hosted computer. See [how Spaces works](https://cua.ai/docs/spaces/concepts/how-spaces-works).

pi-cua connects pi to Linux and macOS Spaces, with experimental Windows support through Git for Windows Bash. Keep pi, your extensions, skills, settings and model credentials local; run workspace tools on the selected Space and bring Git changes back when you return. Cua Spaces tools are also discoverable through `tool_search`.

```mermaid
flowchart LR
  P["Local pi session"] -->|"workspace tools"| S["Cua Space on your computers"]
  S -->|"Git changes on return"| W["Local checkout"]
```

## Get started

1. Set up [Cua Spaces](https://cua.ai/) and [connect a computer](https://cua.ai/docs/spaces/guides/add-a-computer), or create a local Space.
2. Install the extension:

   ```sh
   pi install git:github.com/injaneity/pi-cua
   ```

3. Open pi and run `/space`. If pi is already open, run `/reload` first.

The destination needs Node.js 22+ and Git. [Windows additionally needs Git for Windows Bash](#experimental-windows-spaces). pi-cua checks prerequisites on entry; you do not install pi on the Space.

Local Spaces and direct connections do not require a Cua account. Relay access uses Cua sign-in. `/space create` requires a supported local runtime.

<details>
<summary>Prefer the Cua CLI?</summary>

```sh
curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --yes
cua auth login
```

Use the [Cua setup guide](https://cua.ai/docs/spaces/guides/add-a-computer) for the computers you want to connect. No custom pi-cua container image or separate tool-host package is required.

</details>

## Choose a Space

`/space` and the agent's `space` tool take the same argument:

| argument | does |
|---|---|
| _(none)_ | lists Spaces; `/space` opens a picker |
| `<name>` | enters that Space |
| `local` | brings the work back into your checkout and runs locally again |
| `create [name]` | creates a Space on this machine and enters it |
| `delete <name>` | deletes a Space |
| `auth` | checks GitHub authentication on the current Space |

Creating and deleting always ask you to confirm, whoever asks. Resume never substitutes a different machine: if the saved Space is gone or reports a different machine identity, pi stops and asks you to choose.

## Your accounts stay yours

Credentials stay on their own machine. Model and MCP sign-ins remain local; command-line tools on a Space use that Space's accounts. No OAuth tokens, SSH keys or credential files are copied or forwarded.

After entering a Space, `/space auth` checks the GitHub CLI without displaying credentials. It reports whether `gh` is missing or authentication is unavailable and suggests the next step. Run interactive sign-in in a terminal on the Space (not pi's non-interactive `!` shell); browser/device-code flows can be approved from your own browser. GitHub HTTPS Git access may additionally need `gh auth setup-git`; SSH remotes need their own SSH authentication. There is no cross-environment GitHub action sharing yet.

Pasted `pi-clipboard-*` images in pi's local temporary directory remain readable from your machine while workspace reads run remotely. This exception is read-only and does not route arbitrary local paths.

The picker shows online Spaces first, then those still being checked, then offline Spaces. Availability updates preserve your filter and selected Space.

## Cua Spaces tools

The tool catalogue exposed by the installed Cua Spaces SDK—including Space management, agents, sharing, Teleport and more—is registered as `cua_<tool>` at startup. Tool definitions stay out of the prompt until `tool_search` loads them. Availability depends on your SDK version and connected computers. Any tool the SDK marks destructive asks you to confirm first, whether you or the agent called it.

## From your checkout and back

```
enter(space)
  1. resolve   online, node and git present, same machine as before
  2. copy      your Git workspace, only the objects the Space is missing
  3. route     read · write · edit · bash · find · grep · ! → the Space
```

- **workspace.** For a Git repository with a network `origin`, pi-cua copies your working tree, including uncommitted and untracked files, into `~/.cua-pi/work/<execution>`. It sends only the Git objects the Space is missing and verifies the full tree before use. If the Space cannot reach `origin`, it starts from a commit snapshot instead. Moving between Spaces transfers objects through your machine; `/space local` applies one tree diff to your checkout, merging non-conflicting local edits. Directories outside Git get a separate empty execution directory and are not synchronized.
- **tools.** pi's own tools run unchanged; only their file and shell operations go to the Space through spacesd. Output streams back, and cancelling kills the command on the Space. Every other tool, such as web search or papercuts, runs on your machine. If another extension replaces one of the six tools, it is blocked while you are on a Space instead of quietly acting on local files.

`/new` and `/fork` inherit the Space with their own copy of the workspace.

## Supported today

- Linux and macOS Spaces, plus experimental Windows Spaces using Git for Windows Bash. Windows support has not been runtime-tested.
- Submodules, Git content filters and working-tree encodings are not transferred. Transfers are limited to 200 MiB.
- Sessions on one Space share its user, files and logins. Use a dedicated Space when that matters.
- Workspaces stay on the Space until you return with `/space local`.

## Experimental Windows Spaces

Install Node.js 22+ and Git for Windows on the Windows computer, with `node.exe` and `git.exe` on the PATH of the user running `cua-spacesd`. Restart spacesd after installation. Windows PowerShell (`powershell.exe`) is used to discover the user profile, machine identity and Git Bash location.

`bash` and `!` commands run in Git for Windows Bash—not PowerShell or cmd.exe. Use workspace-relative paths or drive-qualified paths such as `C:/Users/name/project`. UNC paths and drive-relative paths such as `C:project` are not supported. Invoke `powershell.exe` explicitly for PowerShell commands.

Workspace transfer uses the same Git object verification and snapshot fallback as other Spaces. Windows checkouts disable automatic CRLF conversion and require native symlinks rather than silently replacing links with files; repositories with symlinks need Windows Developer Mode or appropriate privileges. Windows filesystem restrictions still apply to filenames and paths.

This implementation is unverified on Windows. Entry, file tools, cancellation, resume, cross-OS transfer and sync-back need validation before relying on it for important work.

## Development

```sh
npm test
```

The tests run the real workspace transfer and pi's own tools against local fake Spaces with their own home directories.

---

Cua marks are provided by [Cua's brand assets](https://cua.ai/branding). pi-cua is an integration for pi; Cua Spaces provides the connected desktops.
