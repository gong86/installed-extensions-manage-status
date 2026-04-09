import * as vscode from 'vscode';

type ExtensionItem = {
  id: string;
  publisher: string;
  name: string;
  version: string;
  description: string;
  iconUri?: vscode.Uri;
  isBuiltin: boolean;
  isActive: boolean;
};

type PackGroup = {
  id: string;
  label: string;
  description: string;
  items: ExtensionItem[];
  isPack: boolean;
};

type SummaryCounts = {
  total: number;
  active: number;
  inactive: number;
  installed: number;
  installedActive: number;
  installedInactive: number;
  builtin: number;
  builtinActive: number;
  builtinInactive: number;
};

export function activate(context: vscode.ExtensionContext): void {
  const provider = new InstalledExtensionsWebviewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'installedExtensionsManageStatusView',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.refresh', () => {
      provider.refresh();
    })
  );
}

export function deactivate(): void {}

class InstalledExtensionsWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private expandedGroupIds = new Set<string>();
  private hasInitializedExpandedGroups = false;
  private selectedExtensionId?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public refresh(): void {
    if (this.view) {
      void this.render(this.view);
    }
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: this.getLocalResourceRoots(),
    };

    webviewView.webview.onDidReceiveMessage(async (message: { type: string; value?: string; expandedIds?: string[]; opening?: boolean }) => {
      switch (message.type) {
        case 'copyId':
          if (message.value) {
            await vscode.env.clipboard.writeText(message.value);
            void vscode.window.showInformationMessage(`Copied: ${message.value}`);
          }
          break;

        case 'copyInstall':
          if (message.value) {
            await vscode.env.clipboard.writeText(`code --install-extension ${message.value}`);
            void vscode.window.showInformationMessage(`Copied install command for ${message.value}`);
          }
          break;

        case 'openMarketplace':
          if (message.value) {
            await vscode.env.openExternal(vscode.Uri.parse(message.value));
          }
          break;

        case 'openExtension':
          if (message.value) {
            this.selectedExtensionId = message.value;
            void this.openExtension(message.value);
          }
          break;

        case 'setSelectedExtension':
          this.selectedExtensionId = message.value;
          break;

        case 'setExpandedGroups':
          this.expandedGroupIds = new Set(message.expandedIds ?? []);
          break;

        case 'refresh':
          await this.render(webviewView);
          break;

        default:
          break;
      }
    });

    await this.render(webviewView);
  }

  private getLocalResourceRoots(): vscode.Uri[] {
    const roots: vscode.Uri[] = [this.context.extensionUri];

    for (const ext of vscode.extensions.all) {
      roots.push(vscode.Uri.file(ext.extensionPath));
    }

    return roots;
  }

  private async setOpeningExtension(id: string, opening: boolean): Promise<void> {
    await this.view?.webview.postMessage({
      type: 'setOpeningExtension',
      value: id,
      opening,
    });
  }

  private async openExtension(id: string): Promise<void> {
    await this.setOpeningExtension(id, true);

    try {
      await vscode.commands.executeCommand('extension.open', id);
    } finally {
      await this.setOpeningExtension(id, false);
    }
  }

  private async render(webviewView: vscode.WebviewView): Promise<void> {
    const webview = webviewView.webview;
    const nonce = getNonce();
    const items = this.getItems(webview);
    const groups = this.getPackGroups(items);
    const counts = this.getCounts(items);

    if (!this.hasInitializedExpandedGroups) {
      this.hasInitializedExpandedGroups = true;
    } else {
      const validGroupIds = new Set(groups.map((group) => group.id));
      this.expandedGroupIds = new Set(
        [...this.expandedGroupIds].filter((id) => validGroupIds.has(id))
      );
    }

    webviewView.description = `${counts.total} total`;
    webview.html = this.getHtml(
      webview,
      nonce,
      groups,
      counts,
      this.expandedGroupIds,
      this.selectedExtensionId
    );
  }

  private getItems(webview: vscode.Webview): ExtensionItem[] {
    return vscode.extensions.all
      .map((ext) => {
        const [publisher, ...rest] = ext.id.split('.');
        const name = rest.join('.') || ext.id;
        const packageJson = ext.packageJSON as {
          version?: string;
          description?: string;
          icon?: string;
          isBuiltin?: boolean;
        };

        let iconUri: vscode.Uri | undefined;
        if (packageJson.icon && typeof packageJson.icon === 'string') {
          try {
            iconUri = webview.asWebviewUri(
              vscode.Uri.joinPath(vscode.Uri.file(ext.extensionPath), packageJson.icon)
            );
          } catch {
            iconUri = undefined;
          }
        }

        return {
          id: ext.id,
          publisher,
          name,
          version: packageJson.version ?? 'unknown',
          description: packageJson.description ?? '',
          iconUri,
          isBuiltin: packageJson.isBuiltin === true,
          isActive: ext.isActive === true,
        } satisfies ExtensionItem;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private getCounts(items: ExtensionItem[]): SummaryCounts {
    const installed = items.filter((item) => !item.isBuiltin);
    const builtin = items.filter((item) => item.isBuiltin);

    return {
      total: items.length,
      active: items.filter((item) => item.isActive).length,
      inactive: items.filter((item) => !item.isActive).length,
      installed: installed.length,
      installedActive: installed.filter((item) => item.isActive).length,
      installedInactive: installed.filter((item) => !item.isActive).length,
      builtin: builtin.length,
      builtinActive: builtin.filter((item) => item.isActive).length,
      builtinInactive: builtin.filter((item) => !item.isActive).length,
    };
  }

  private getPackGroups(items: ExtensionItem[]): PackGroup[] {
    const byId = new Map(items.map((item) => [item.id, item]));
    const assigned = new Set<string>();
    const groups: PackGroup[] = [];

    const packExtensions = vscode.extensions.all
      .map((ext) => {
        const packageJson = ext.packageJSON as {
          displayName?: string;
          description?: string;
          extensionPack?: string[];
        };

        return {
          id: ext.id,
          label: packageJson.displayName ?? ext.id,
          description: packageJson.description ?? '',
          extensionPack: Array.isArray(packageJson.extensionPack) ? packageJson.extensionPack : [],
        };
      })
      .filter((ext) => ext.extensionPack.length > 0)
      .sort((a, b) => a.label.localeCompare(b.label));

    for (const pack of packExtensions) {
      const packItems: ExtensionItem[] = [];

      for (const childId of pack.extensionPack) {
        const found = byId.get(childId);
        if (found) {
          packItems.push(found);
          assigned.add(childId);
        }
      }

      if (packItems.length > 0) {
        groups.push({
          id: pack.id,
          label: pack.label,
          description: pack.description,
          items: packItems.sort((a, b) => a.id.localeCompare(b.id)),
          isPack: true,
        });
      }
    }

    const notInPack = items.filter(
      (item) => !assigned.has(item.id) && !packExtensions.some((pack) => pack.id === item.id)
    );

    const installed = notInPack.filter((item) => !item.isBuiltin);
    const builtin = notInPack.filter((item) => item.isBuiltin);

    if (installed.length > 0) {
      groups.push({
        id: 'other-installed',
        label: 'Other Installed',
        description: 'Installed extensions not listed in an installed extension pack',
        items: installed.sort((a, b) => a.id.localeCompare(b.id)),
        isPack: false,
      });
    }

    if (builtin.length > 0) {
      groups.push({
        id: 'builtin',
        label: 'Built-in',
        description: 'Built-in extensions not listed in an installed extension pack',
        items: builtin.sort((a, b) => a.id.localeCompare(b.id)),
        isPack: false,
      });
    }

    return groups;
  }

  private getHtml(
    webview: vscode.Webview,
    nonce: string,
    groups: PackGroup[],
    counts: SummaryCounts,
    expandedGroupIds: Set<string>,
    selectedExtensionId?: string
  ): string {
    const statsHtml = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total</div>
          <div class="stat-value">${counts.total}</div>
          <div class="stat-sub">Active ${counts.active} · Idle ${counts.inactive}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Installed</div>
          <div class="stat-value">${counts.installed}</div>
          <div class="stat-sub">Active ${counts.installedActive} · Idle ${counts.installedInactive}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Built-in</div>
          <div class="stat-value">${counts.builtin}</div>
          <div class="stat-sub">Active ${counts.builtinActive} · Idle ${counts.builtinInactive}</div>
        </div>
      </div>
    `;

    const sections = groups.map((group) => {
      const activeCount = group.items.filter((item) => item.isActive).length;
      const inactiveCount = group.items.length - activeCount;

      const cards = group.items.map((item) => {
        const icon = item.iconUri
          ? `<img class="icon" src="${item.iconUri.toString()}" alt="" />`
          : `<div class="icon fallback">🧩</div>`;

        const marketplaceUrl =
          `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(item.id)}`;
        const statusClass = item.isActive ? 'active' : 'inactive';
        const statusText = item.isActive ? 'Active' : 'Idle';
        const kindText = item.isBuiltin ? 'Built-in' : '';

        return `
          <article
            class="card ${selectedExtensionId === item.id ? 'selected' : ''}"
            data-id="${escapeHtml(item.id)}"
            role="button"
            tabindex="0"
            aria-label="Open ${escapeHtml(item.id)}"
          >
            <div class="card-main">
              ${icon}
              <div class="meta">
                <div class="title-row">
                  <span class="card-title">${escapeHtml(item.name)}</span>
                  ${kindText ? `<span class="badge kind-badge">${escapeHtml(kindText)}</span>` : ''}
                  <span class="badge status-badge ${statusClass}">${escapeHtml(statusText)}</span>
                  <span class="badge opening-badge" hidden>Requested...</span>
                </div>
                <div class="publisher">${escapeHtml(item.publisher)}</div>
                <div class="desc">${escapeHtml(item.description || 'No description')}</div>
              </div>
              <div class="side">
                <div class="version">${escapeHtml(item.version)}</div>
              </div>
            </div>
            <div class="actions">
              <button data-action="copyId" data-value="${escapeHtml(item.id)}">Copy ID</button>
              <button data-action="copyInstall" data-value="${escapeHtml(item.id)}">Copy Install Cmd</button>
              <button data-action="openMarketplace" data-value="${escapeHtml(marketplaceUrl)}">Marketplace</button>
            </div>
          </article>
        `;
      }).join('\n');

      const openAttr = expandedGroupIds.has(group.id) ? 'open' : '';

      return `
        <details class="group" data-group-id="${escapeHtml(group.id)}" ${openAttr}>
          <summary>
            <div class="group-title-row">
              <div class="group-title-wrap">
                <span class="group-title">${escapeHtml(group.label)}</span>
                <span class="group-count">${group.items.length}</span>
              </div>
              <div class="group-desc">${escapeHtml(group.description || '')}</div>
              <div class="group-meta">Active ${activeCount} · Idle ${inactiveCount}</div>
            </div>
          </summary>
          <div class="group-body">
            ${cards}
          </div>
        </details>
      `;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Installed Extensions</title>
  <style>
    :root { color-scheme: light dark; }

    @keyframes openingPulse {
      0% { opacity: 0.55; }
      50% { opacity: 1; }
      100% { opacity: 0.55; }
    }

    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      margin: 0;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 12px;
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      padding-bottom: 8px;
      z-index: 2;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font: inherit;
    }

    .card-title {
      color: var(--vscode-textLink-foreground);
      font-size: 13px;
      font-weight: 600;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .count {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-left: auto;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }

    .stat-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
      padding: 10px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    }

    .stat-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .stat-value {
      font-size: 22px;
      font-weight: 700;
      margin-top: 4px;
    }

    .stat-sub {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      line-height: 1.35;
    }

    .group {
      border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      border-radius: 10px;
      margin-bottom: 10px;
      overflow: hidden;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    }

    summary {
      list-style: none;
      cursor: pointer;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 80%, transparent);
    }

    summary::-webkit-details-marker {
      display: none;
    }

    .group-title-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .group-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }

    .group-count,
    .group-meta,
    .group-desc {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .group-body {
      display: grid;
      gap: 10px;
      padding: 10px;
    }

    .card {
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      border-radius: 10px;
      padding: 10px;
      cursor: pointer;
      transition: transform 80ms ease, background-color 80ms ease, border-color 80ms ease;
    }

    .card-main {
      display: grid;
      grid-template-columns: 40px 1fr auto;
      gap: 10px;
      align-items: start;
    }

    .card.selected {
      border-color: var(--vscode-focusBorder);
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 20%, var(--vscode-sideBar-background));
    }

    .card.opening {
      border-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      background: color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-focusBorder)) 12%, var(--vscode-sideBar-background));
    }

    .card.opening .icon {
      animation: openingPulse 1s ease-in-out infinite;
    }

    .card:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .card:active {
      transform: scale(0.99);
      background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 28%, var(--vscode-sideBar-background));
      border-color: var(--vscode-focusBorder);
    }

    .icon {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      object-fit: contain;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }

    .fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .title-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--vscode-badge-background);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      line-height: 1.2;
    }

    .kind-badge {
      color: var(--vscode-descriptionForeground);
      background: transparent;
    }

    .opening-badge {
      background: color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-focusBorder)) 18%, transparent);
      color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
      border-color: color-mix(in srgb, var(--vscode-progressBar-background, var(--vscode-focusBorder)) 45%, transparent);
      animation: openingPulse 1s ease-in-out infinite;
    }

    .opening-badge[hidden] {
      display: none !important;
    }

    .status-badge.active {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 20%, transparent);
      color: var(--vscode-testing-iconPassed);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 55%, transparent);
    }

    .status-badge.inactive {
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 16%, transparent);
      color: var(--vscode-descriptionForeground);
      border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent);
    }

    .publisher,
    .desc,
    .version {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .publisher {
      margin-top: 4px;
      font-weight: 500;
    }

    .desc {
      margin-top: 6px;
      line-height: 1.35;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }

    .actions button {
      padding: 4px 8px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button data-action="refresh">Refresh</button>
    <div class="count">${counts.total} total</div>
  </div>

  ${statsHtml}
  ${sections}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let selectedCardId = ${JSON.stringify(selectedExtensionId ?? '')};
    const openingCardIds = new Set();
    const openingCardTimers = new Map();
    const openingIndicatorDelayMs = 160;
    let suppressCardClick = false;

    function sendExpandedGroups() {
      const expandedIds = Array.from(
        document.querySelectorAll('details.group[open][data-group-id]')
      ).map((el) => el.getAttribute('data-group-id')).filter(Boolean);

      vscode.postMessage({
        type: 'setExpandedGroups',
        expandedIds
      });
    }

    function setSelectedCard(id) {
      if (selectedCardId === id) {
        return;
      }

      selectedCardId = id;

      document.querySelectorAll('.card.selected').forEach((el) => {
        el.classList.remove('selected');
      });

      const next = document.querySelector('.card[data-id="' + id + '"]');
      if (next) {
        next.classList.add('selected');
      }

      vscode.postMessage({
        type: 'setSelectedExtension',
        value: id
      });
    }

    function setOpeningCard(id, opening) {
      const card = document.querySelector('.card[data-id="' + id + '"]');
      if (!(card instanceof HTMLElement)) {
        return;
      }

      const badge = card.querySelector('.opening-badge');
      const existingTimer = openingCardTimers.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        openingCardTimers.delete(id);
      }

      if (opening) {
        openingCardIds.add(id);
        card.setAttribute('aria-busy', 'true');

        const timer = setTimeout(() => {
          openingCardTimers.delete(id);
          if (!openingCardIds.has(id)) {
            return;
          }

          card.classList.add('opening');
          if (badge instanceof HTMLElement) {
            badge.hidden = false;
          }
        }, openingIndicatorDelayMs);

        openingCardTimers.set(id, timer);
      } else {
        openingCardIds.delete(id);
        card.classList.remove('opening');
        card.removeAttribute('aria-busy');
        if (badge instanceof HTMLElement) {
          badge.hidden = true;
        }
      }
    }

    function openCard(id) {
      setSelectedCard(id);
      setOpeningCard(id, true);
      vscode.postMessage({
        type: 'openExtension',
        value: id
      });
    }

    document.querySelectorAll('details.group').forEach((details) => {
      details.addEventListener('toggle', sendExpandedGroups);
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'setOpeningExtension') {
        if (typeof message.value !== 'string' || typeof message.opening !== 'boolean') {
          return;
        }

        setOpeningCard(message.value, message.opening);
      }
    });

    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;

      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.action) return;

      const card = target.closest('.card[data-id]');
      if (!(card instanceof HTMLElement)) return;

      const id = card.getAttribute('data-id');
      if (!id) return;

      suppressCardClick = true;
      openCard(id);
    });

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      const action = target.dataset.action;
      if (action) {
        vscode.postMessage({
          type: action,
          value: target.dataset.value
        });
        return;
      }

      const card = target.closest('.card[data-id]');
      if (!(card instanceof HTMLElement)) return;

      if (suppressCardClick) {
        suppressCardClick = false;
        return;
      }

      const id = card.getAttribute('data-id');
      if (!id) return;

      openCard(id);
    });

    document.addEventListener('keydown', (event) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.dataset.action) return;

      const card = event.target.closest('.card[data-id]');
      if (!(card instanceof HTMLElement)) return;

      const id = card.getAttribute('data-id');
      if (!id) return;

      event.preventDefault();
      openCard(id);
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';

  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
