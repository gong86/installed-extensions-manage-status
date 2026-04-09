# Development

This document describes the basic local development workflow for this extension.

## Prerequisites

- Node.js (LTS) and `npm` (or an equivalent package manager).
- Visual Studio Code for debugging and extension host.

## Quick start

Install dependencies and build:

```bash
npm install
npm run compile
```

During development, run the TypeScript watcher:

```bash
npm run watch
```

To run the extension in a development host:

1. Open the project in VS Code.
2. Press `F5` to launch the Extension Development Host.

Alternatively, run the extension development host from the terminal:

```bash
code --extensionDevelopmentPath=$(pwd)
```

## Packaging

Package a VSIX for manual install / marketplace publishing:

```bash
npm run package
```

Note: `.vscodeignore` excludes development helper files (see `scripts/**`).

## Linting / Type checking

Run TypeScript type checks (no emit):

```bash
npm run lint
```

## Notes & conventions

- The extension shows an Activity Bar webview with grouping modes and per-extension cards. It does not perform installs/uninstalls or enable/disable actions.
- Keep changes small and run `npm run compile` before committing to ensure type-safety.
- Use feature branches and descriptive commit messages.

## Repository

https://github.com/gong86/installed-extensions-manage-status
