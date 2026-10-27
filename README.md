# Claude Code for Saturn

A Saturn extension (module API `^0.2`) that brings the [Claude Code](https://claude.com/claude-code) CLI into the editor.

Requires the `claude` CLI: `npm i -g @anthropic-ai/claude-code`.

## Features

- **CC button** (right bar) and **Claude Code: Open / Continue / Resume / Usage** commands open Claude Code in a Terminal tab.
- **Run menu**: start Claude Code, continue the last session, pick a session to resume, show usage, or resume one of the project's recent sessions directly. Each runs in a Terminal tab.
- **Claude Code panel** (left dock): the project's `CLAUDE.md`, `CLAUDE.local.md`, `.claude/settings*.json` and `.mcp.json`, plus its custom commands, agents, skills, MCP servers and recent sessions (with a Resume action).
- **Explain Selection / Explain This File**: start Claude Code asking about the active file, or just the selected lines (`@path#L10-42`).
- **Commands**: Open CLAUDE.md (creates it if it's missing), Open Project Settings, Check Installation, Refresh Panel.
- **Settings**: Claude executable path, model, permission mode, extra arguments, and how many recent sessions to show.

## Development

Install from Marketplace → Extensions → Install from folder…, and pick this folder.

Pushing to `main` with a new `version` in `saturn-extension.json` publishes a GitHub Release zip.
