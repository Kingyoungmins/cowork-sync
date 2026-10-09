# Security policy

## Supported versions

Only the latest preview release gets security fixes. Today that is
0.1.0-preview. Older previews are not patched; update to the latest one.

## Reporting a problem

Report security problems **only** through GitHub's private vulnerability
reporting: open the repository's "Security" tab and choose "Report a
vulnerability". Please do not open a public issue, and do not send security
reports by e-mail. The e-mail address in the README is for general questions
only.

Please include:

- the cowork-sync version, your operating system, and your git and Node.js
  versions;
- the steps to reproduce, with the smallest repository that shows the problem;
- what you expected and what happened.

Do not include real secrets or private repository content. A made-up value is
enough to show a leak.

This is a personal project. Reports are read and answered as time allows, and
there is no bug bounty.

## What counts as a security issue

cowork-sync writes into working trees and pushes to git remotes, so its
security boundary is about what it writes, what it pushes and what it runs.
Examples of what to report:

- cowork-sync writes a file outside the repository's working tree, or follows a
  symbolic link out of it.
- A path in the quarantine set (`.claude/`, `.mcp.json`, `CLAUDE.md`,
  `.github/workflows/`, `.gitattributes`, git hook folders and the others in
  the glossary's quarantine list) is published or written live.
- A new file whose name matches a secret-like pattern (`.env`, `*.pem`, `*.key`,
  `id_rsa*` and the others) is shared anyway.
- Content fetched from the remote causes code to run on a PC: a hook, a filter,
  a script, or an argument that git reads as an option.
- cowork-sync pushes to a branch (`refs/heads/*`), deletes a remote ref, or
  updates a board ref in a way that is not a leased fast-forward.
- Credentials, tokens or the userinfo part of a remote URL appear in a log,
  `status.json`, a board commit, a printed line or the viewer.
- The local viewer can be reached from another machine, or from a web page
  without its token.
- One teammate's board content can make another PC lose local work without
  keeping a copy.

## Known limitations (not vulnerabilities)

These are known gaps in the preview. They are listed in the README and will be
closed in later releases:

- The remote is not checked for being private. Anyone who can read the
  repository can read the shared work in `refs/cowork/*`.
- File contents are not scanned for secrets. Only file names are checked.
- Teammates are trusted with their own edits. Anyone with write access to the
  repository can change what is synced into your working tree, as with any
  shared branch.
