# Installed Extensions Manage Status

Browse your installed VS Code extensions from a compact Activity Bar webview. The extension presents extension cards, summary statistics, and several grouping modes so you can inspect installed and built-in extensions quickly.

## What it does

- Adds an Activity Bar container `Ext Manage` with the `Installed Extensions` webview view.
- Displays per-extension cards with icon, name, publisher, description, version, and badges for Active / Idle and Built-in.
- Shows summary cards: Total, Installed, Built-in with Active/Idle breakdowns.
- Grouping modes: **Pack**, **Publisher**, **Category**, **Category (All)**.
- Per-card actions: **Copy ID**, **Copy Install Cmd** (copies `code --install-extension <id>`), **Marketplace** (opens the extension's Marketplace page), and clicking a card opens the extension details in VS Code.
- Retains webview context when hidden and remembers expanded groups during the session.

## What it doesn't do

- It does not install/uninstall/enable/disable extensions directly from the webview.

## Commands

- `Refresh Installed Extensions` — refresh the view programmatically (contributed command `installedExtensionsManageStatus.refresh`).

## Contributing

Contributions welcome — open issues or pull requests at https://github.com/gong86/installed-extensions-manage-status

## License

MIT
