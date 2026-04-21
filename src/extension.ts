import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

type ExtensionItem = {
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  categories: string[];
  version: string;
  description: string;
  iconUri?: vscode.Uri;
  extensionPack: string[];
  extensionPath?: string;
  isBuiltin: boolean;
  isActive: boolean;
  isDisabled: boolean;
};

type ExtensionManifest = {
  name?: string;
  publisher?: string;
  displayName?: string;
  version?: string;
  description?: string;
  icon?: string;
  isBuiltin?: boolean;
  categories?: string[];
  extensionPack?: string[];
};

type ExtensionsJsonEntry = {
  identifier?: {
    id?: string;
  };
  version?: string;
  location?: {
    path?: string;
    fsPath?: string;
  };
  relativeLocation?: string;
  metadata?: {
    isBuiltin?: boolean;
    publisherDisplayName?: string;
  };
};

type InstalledExtensionRecord = {
  id: string;
  extensionPath?: string;
  version?: string;
  isBuiltin: boolean;
  publisherDisplayName?: string;
};

type ExtensionInventory = {
  items: ExtensionItem[];
  localResourceRoots: vscode.Uri[];
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
  disabled: number;
  installed: number;
  installedActive: number;
  installedInactive: number;
  installedDisabled: number;
  builtin: number;
  builtinActive: number;
  builtinInactive: number;
  builtinDisabled: number;
};

type GroupMode = 'pack' | 'publisher' | 'category' | 'category-all';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new InstalledExtensionsWebviewProvider(context);

  context.subscriptions.push(provider);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByPack', () => {
      provider.setGroupMode('pack');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByPublisher', () => {
      provider.setGroupMode('publisher');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByCategory', () => {
      provider.setGroupMode('category');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByCategoryAll', () => {
      provider.setGroupMode('category-all');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.toggleBuiltin', () => {
      provider.toggleBuiltin();
    })
  );

  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      provider.scheduleRefresh();
    })
  );
}

export function deactivate(): void {}

class InstalledExtensionsWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private expandedGroupIds = new Set<string>();
  private hasInitializedExpandedGroups = false;
  private selectedExtensionId?: string;
  private groupMode: GroupMode = 'pack';
  private showBuiltin = false;
  private refreshHandle?: NodeJS.Timeout;
  private activityPollHandle?: NodeJS.Timeout;
  private lastRuntimeActivitySignature = '';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public dispose(): void {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
      this.refreshHandle = undefined;
    }

    this.stopActivityPolling();
  }

  public refresh(): void {
    if (this.view) {
      void this.render(this.view);
    }
  }

  public scheduleRefresh(delayMs = 150): void {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
    }

    this.refreshHandle = setTimeout(() => {
      this.refreshHandle = undefined;
      this.refresh();
    }, delayMs);
  }

  private stopActivityPolling(): void {
    if (this.activityPollHandle) {
      clearInterval(this.activityPollHandle);
      this.activityPollHandle = undefined;
    }
  }

  private updateActivityPolling(): void {
    if (!this.view?.visible) {
      this.stopActivityPolling();
      return;
    }

    if (this.activityPollHandle) {
      return;
    }

    this.activityPollHandle = setInterval(() => {
      const nextSignature = this.getRuntimeActivitySignature();
      if (nextSignature === this.lastRuntimeActivitySignature) {
        return;
      }

      this.lastRuntimeActivitySignature = nextSignature;
      this.refresh();
    }, 1200);
  }

  private getRuntimeActivitySignature(): string {
    return vscode.extensions.all
      .map((ext) => `${ext.id.toLowerCase()}:${ext.isActive ? '1' : '0'}`)
      .sort((a, b) => a.localeCompare(b))
      .join('|');
  }

  public setGroupMode(mode: GroupMode): void {
    this.groupMode = mode;
    this.expandedGroupIds.clear();
    if (this.view) {
      void this.render(this.view);
    }
  }

  public toggleBuiltin(): void {
    this.showBuiltin = !this.showBuiltin;
    this.expandedGroupIds.clear();
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
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.onDidChangeVisibility(() => {
      this.updateActivityPolling();
      if (webviewView.visible) {
        this.scheduleRefresh(50);
      }
    });

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

        case 'searchPublisher':
          if (message.value) {
            const displayName = this.getPublisherDisplayNames().get(message.value.toLowerCase());
            const query = displayName
              ? `publisher:"${displayName}"`
              : `@publisher:${message.value}`;
            void vscode.commands.executeCommand('workbench.extensions.search', query);
            await this.view?.webview.postMessage({
              type: 'resetGroupBtn',
              value: message.value,
            });
          }
          break;

        case 'searchCategory':
          if (message.value) {
            void vscode.commands.executeCommand('workbench.extensions.search', `@category:"${message.value}"`);
            await this.view?.webview.postMessage({
              type: 'resetGroupBtn',
              value: message.value,
            });
          }
          break;

        case 'setSelectedExtension':
          this.selectedExtensionId = message.value;
          break;

        case 'setExpandedGroups':
          this.expandedGroupIds = new Set(message.expandedIds ?? []);
          break;

        case 'setGroupMode':
          if (
            message.value === 'pack'
            || message.value === 'publisher'
            || message.value === 'category'
            || message.value === 'category-all'
          ) {
            this.groupMode = message.value;
            this.expandedGroupIds.clear();
            await this.render(webviewView);
          }
          break;

        case 'setShowBuiltin':
          this.showBuiltin = message.value === 'true';
          this.expandedGroupIds.clear();
          await this.render(webviewView);
          break;

        case 'refresh':
          await this.render(webviewView);
          break;

        default:
          break;
      }
    });

    await this.render(webviewView);
    this.updateActivityPolling();
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
    const inventory = this.getInventory(webview);
    this.lastRuntimeActivitySignature = this.getRuntimeActivitySignature();
    webview.options = {
      enableScripts: true,
      localResourceRoots: inventory.localResourceRoots,
    };

    const items = inventory.items;
    const counts = this.getCounts(items);
    const filteredItems = this.showBuiltin ? items : items.filter((item) => !item.isBuiltin);
    const filteredGroups = this.getGroups(filteredItems);
    const filteredCounts = this.getCounts(filteredItems);

    if (!this.hasInitializedExpandedGroups) {
      this.hasInitializedExpandedGroups = true;
    } else {
      const validGroupIds = new Set(filteredGroups.map((group) => group.id));
      this.expandedGroupIds = new Set(
        [...this.expandedGroupIds].filter((id) => validGroupIds.has(id))
      );
    }

    webviewView.description = `${counts.total} total (${counts.builtin} built-in)`;

    webview.html = this.getHtml(
      webview,
      nonce,
      filteredGroups,
      filteredCounts,
      this.expandedGroupIds,
      this.selectedExtensionId,
      this.groupMode,
      this.showBuiltin
    );
  }

  private getInventory(webview: vscode.Webview): ExtensionInventory {
    const runtimeById = new Map<string, vscode.Extension<unknown>>();
    for (const ext of vscode.extensions.all) {
      runtimeById.set(ext.id.toLowerCase(), ext);
    }

    const itemsById = new Map<string, ExtensionItem>();
    const localResourceRoots: vscode.Uri[] = [this.context.extensionUri];
    const seenRootIds = new Set<string>([this.context.extensionUri.toString()]);

    for (const entry of this.readInstalledExtensionsMetadata()) {
      const runtimeExtension = runtimeById.get(entry.id.toLowerCase());
      const packageJson = (
        entry.extensionPath
          ? this.readExtensionManifest(entry.extensionPath)
          : undefined
      ) ?? (runtimeExtension?.packageJSON as ExtensionManifest | undefined);

      const item = this.createItem(webview, {
        id: entry.id,
        extensionPath: entry.extensionPath ?? runtimeExtension?.extensionPath,
        packageJson,
        fallbackVersion: entry.version,
        isBuiltin: entry.isBuiltin,
        isActive: runtimeExtension?.isActive === true,
        isDisabled: !entry.isBuiltin && !runtimeExtension,
      });

      if (!item) {
        continue;
      }

      itemsById.set(item.id.toLowerCase(), item);
      this.addLocalResourceRoot(localResourceRoots, seenRootIds, item.extensionPath);
    }

    for (const ext of vscode.extensions.all) {
      if (itemsById.has(ext.id.toLowerCase())) {
        this.addLocalResourceRoot(localResourceRoots, seenRootIds, ext.extensionPath);
        continue;
      }

      const packageJson = ext.packageJSON as ExtensionManifest;
      const item = this.createItem(webview, {
        id: ext.id,
        extensionPath: ext.extensionPath,
        packageJson,
        isBuiltin: packageJson.isBuiltin === true,
        isActive: ext.isActive === true,
        isDisabled: false,
      });

      if (!item) {
        continue;
      }

      itemsById.set(item.id.toLowerCase(), item);
      this.addLocalResourceRoot(localResourceRoots, seenRootIds, item.extensionPath);
    }

    return {
      items: [...itemsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
      localResourceRoots,
    };
  }

  private createItem(
    webview: vscode.Webview,
    options: {
      id?: string;
      extensionPath?: string;
      packageJson?: ExtensionManifest;
      fallbackVersion?: string;
      isBuiltin: boolean;
      isActive: boolean;
      isDisabled: boolean;
    }
  ): ExtensionItem | undefined {
    const resolvedId = options.id
      ?? (
        options.packageJson?.publisher && options.packageJson.name
          ? `${options.packageJson.publisher}.${options.packageJson.name}`
          : undefined
      );

    if (!resolvedId) {
      return undefined;
    }

    const [publisher, ...rest] = resolvedId.split('.');
    const name = rest.join('.') || options.packageJson?.name || resolvedId;

    let iconUri: vscode.Uri | undefined;
    if (
      options.extensionPath
      && typeof options.packageJson?.icon === 'string'
      && options.packageJson.icon.length > 0
    ) {
      try {
        iconUri = webview.asWebviewUri(
          vscode.Uri.joinPath(vscode.Uri.file(options.extensionPath), options.packageJson.icon)
        );
      } catch {
        iconUri = undefined;
      }
    }

    return {
      id: resolvedId,
      publisher,
      name,
      displayName: options.packageJson?.displayName?.trim() || name,
      categories: Array.isArray(options.packageJson?.categories) && options.packageJson.categories.length > 0
        ? options.packageJson.categories
        : ['Uncategorized'],
      version: options.packageJson?.version ?? options.fallbackVersion ?? 'unknown',
      description: options.packageJson?.description ?? '',
      iconUri,
      extensionPack: Array.isArray(options.packageJson?.extensionPack)
        ? options.packageJson.extensionPack
        : [],
      extensionPath: options.extensionPath,
      isBuiltin: options.isBuiltin || options.packageJson?.isBuiltin === true,
      isActive: options.isActive,
      isDisabled: options.isDisabled,
    };
  }

  private addLocalResourceRoot(
    roots: vscode.Uri[],
    seenRootIds: Set<string>,
    extensionPath?: string
  ): void {
    if (!extensionPath) {
      return;
    }

    const uri = vscode.Uri.file(extensionPath);
    const rootId = uri.toString();
    if (seenRootIds.has(rootId)) {
      return;
    }

    seenRootIds.add(rootId);
    roots.push(uri);
  }

  private readExtensionManifest(extensionPath: string): ExtensionManifest | undefined {
    try {
      const packageJsonPath = path.join(extensionPath, 'package.json');
      const raw = fs.readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as ExtensionManifest;
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private readInstalledExtensionsMetadata(): InstalledExtensionRecord[] {
    const extensionsDir = this.getUserExtensionsDir();
    if (!extensionsDir) {
      return [];
    }

    try {
      const extensionsJsonPath = path.join(extensionsDir, 'extensions.json');
      const raw = fs.readFileSync(extensionsJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as ExtensionsJsonEntry[];
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.flatMap((entry) => {
        if (!entry.identifier?.id) {
          return [];
        }

        const extensionPath = (
          typeof entry.location?.fsPath === 'string' && entry.location.fsPath.length > 0
            ? entry.location.fsPath
            : typeof entry.location?.path === 'string' && entry.location.path.length > 0
              ? entry.location.path
              : typeof entry.relativeLocation === 'string' && entry.relativeLocation.length > 0
                ? path.join(extensionsDir, entry.relativeLocation)
                : undefined
        );

        return [{
          id: entry.identifier.id,
          extensionPath,
          version: entry.version,
          isBuiltin: entry.metadata?.isBuiltin === true,
          publisherDisplayName: entry.metadata?.publisherDisplayName,
        }];
      });
    } catch {
      return [];
    }
  }

  private getUserExtensionsDir(): string | undefined {
    const runtimeExtension = vscode.extensions.all.find(
      (ext) => !(ext.packageJSON as ExtensionManifest).isBuiltin
    );
    if (runtimeExtension) {
      return path.dirname(runtimeExtension.extensionPath);
    }

    const envExtensionsDir = process.env.VSCODE_EXTENSIONS;
    if (
      envExtensionsDir
      && fs.existsSync(path.join(envExtensionsDir, 'extensions.json'))
    ) {
      return envExtensionsDir;
    }

    const homeDir = os.homedir();
    const candidates = [
      path.join(homeDir, '.vscode', 'extensions'),
      path.join(homeDir, '.vscode-insiders', 'extensions'),
      path.join(homeDir, '.vscode-oss', 'extensions'),
      path.join(homeDir, '.vscode-server', 'extensions'),
      path.join(homeDir, '.vscode-server-insiders', 'extensions'),
      path.join(homeDir, '.cursor', 'extensions'),
      path.join(homeDir, '.cursor-server', 'extensions'),
      path.join(homeDir, '.windsurf', 'extensions'),
    ];

    return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'extensions.json')));
  }

  private getCounts(items: ExtensionItem[]): SummaryCounts {
    const installed = items.filter((item) => !item.isBuiltin);
    const builtin = items.filter((item) => item.isBuiltin);
    const idle = items.filter((item) => !item.isActive && !item.isDisabled);
    const installedIdle = installed.filter((item) => !item.isActive && !item.isDisabled);
    const builtinIdle = builtin.filter((item) => !item.isActive && !item.isDisabled);
    const disabled = items.filter((item) => item.isDisabled);
    const installedDisabled = installed.filter((item) => item.isDisabled);
    const builtinDisabled = builtin.filter((item) => item.isDisabled);

    return {
      total: items.length,
      active: items.filter((item) => item.isActive).length,
      inactive: idle.length,
      disabled: disabled.length,
      installed: installed.length,
      installedActive: installed.filter((item) => item.isActive).length,
      installedInactive: installedIdle.length,
      installedDisabled: installedDisabled.length,
      builtin: builtin.length,
      builtinActive: builtin.filter((item) => item.isActive).length,
      builtinInactive: builtinIdle.length,
      builtinDisabled: builtinDisabled.length,
    };
  }

  private getGroups(items: ExtensionItem[]): PackGroup[] {
    if (this.groupMode === 'publisher') {
      return this.getPublisherGroups(items);
    }

    if (this.groupMode === 'category') {
      return this.getCategoryGroups(items);
    }

    if (this.groupMode === 'category-all') {
      return this.getCategoryGroups(items, true);
    }

    return this.getPackGroups(items);
  }

  private getPackGroups(items: ExtensionItem[]): PackGroup[] {
    const byId = new Map(items.map((item) => [item.id.toLowerCase(), item]));
    const assigned = new Set<string>();
    const groups: PackGroup[] = [];

    const packExtensions = items
      .map((item) => {
        return {
          id: item.id,
          label: item.displayName || item.id,
          description: item.description,
          extensionPack: item.extensionPack,
        };
      })
      .filter((ext) => ext.extensionPack.length > 0)
      .sort((a, b) => a.label.localeCompare(b.label));

    for (const pack of packExtensions) {
      const packItems: ExtensionItem[] = [];

      for (const childId of pack.extensionPack) {
        const found = byId.get(childId.toLowerCase());
        if (found) {
          packItems.push(found);
          assigned.add(found.id.toLowerCase());
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
      (item) => !assigned.has(item.id.toLowerCase()) && !packExtensions.some((pack) => pack.id === item.id)
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

  private getPublisherDisplayNames(): Map<string, string> {
    const names = new Map<string, string>();

    for (const entry of this.readInstalledExtensionsMetadata()) {
      if (!entry.publisherDisplayName) {
        continue;
      }

      const [publisherId] = entry.id.split('.');
      const publisherKey = publisherId?.toLowerCase();
      if (publisherKey && !names.has(publisherKey)) {
        names.set(publisherKey, entry.publisherDisplayName);
      }
    }

    return names;
  }

  private getPublisherGroups(items: ExtensionItem[]): PackGroup[] {
    const groupsByPublisher = new Map<string, ExtensionItem[]>();
    const displayNames = this.getPublisherDisplayNames();

    for (const item of items) {
      const publisher = item.publisher || 'unknown';
      const existing = groupsByPublisher.get(publisher);
      if (existing) {
        existing.push(item);
      } else {
        groupsByPublisher.set(publisher, [item]);
      }
    }

    return [...groupsByPublisher.entries()]
      .sort(([a], [b]) => {
        const aName = displayNames.get(a.toLowerCase()) ?? a;
        const bName = displayNames.get(b.toLowerCase()) ?? b;
        return aName.localeCompare(bName);
      })
      .map(([publisher, publisherItems]) => {
        const displayName = displayNames.get(publisher.toLowerCase()) ?? publisher;
        const installedCount = publisherItems.filter((item) => !item.isBuiltin).length;
        const builtinCount = publisherItems.length - installedCount;
        const descriptionParts: string[] = [];

        if (installedCount > 0) {
          descriptionParts.push(`${installedCount} installed`);
        }

        if (builtinCount > 0) {
          descriptionParts.push(`${builtinCount} built-in`);
        }

        return {
          id: `publisher:${publisher}`,
          label: displayName,
          description: descriptionParts.join(' · '),
          items: publisherItems.sort((a, b) => a.id.localeCompare(b.id)),
          isPack: false,
        };
      });
  }

  private getCategoryGroups(items: ExtensionItem[], duplicateAcrossCategories = false): PackGroup[] {
    const groupsByCategory = new Map<string, ExtensionItem[]>();

    for (const item of items) {
      const categories = duplicateAcrossCategories
        ? item.categories
        : [item.categories[0] ?? 'Uncategorized'];

      for (const category of categories) {
        const existing = groupsByCategory.get(category);
        if (existing) {
          existing.push(item);
        } else {
          groupsByCategory.set(category, [item]);
        }
      }
    }

    return [...groupsByCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, categoryItems]) => {
        const installedCount = categoryItems.filter((item) => !item.isBuiltin).length;
        const builtinCount = categoryItems.length - installedCount;
        const descriptionParts: string[] = [];

        if (installedCount > 0) {
          descriptionParts.push(`${installedCount} installed`);
        }

        if (builtinCount > 0) {
          descriptionParts.push(`${builtinCount} built-in`);
        }

        return {
          id: `category:${category}`,
          label: category,
          description: descriptionParts.join(' · '),
          items: categoryItems.sort((a, b) => a.id.localeCompare(b.id)),
          isPack: false,
        };
      });
  }

  private getHtml(
    webview: vscode.Webview,
    nonce: string,
    groups: PackGroup[],
    counts: SummaryCounts,
    expandedGroupIds: Set<string>,
    selectedExtensionId?: string,
    groupMode: GroupMode = 'pack',
    showBuiltin = true
  ): string {
    const formatStateSummary = (activeCount: number, idleCount: number, disabledCount: number): string => {
      const parts = [`Active ${activeCount}`, `Idle ${idleCount}`];
      if (disabledCount > 0) {
        parts.push(`Disabled ${disabledCount}`);
      }

      return parts.join(' · ');
    };

    const statsHtml = showBuiltin ? `
      <div class="stats-grid" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
        <div class="stat-card">
          <div class="stat-label">Total</div>
          <div class="stat-value">${counts.total}</div>
          <div class="stat-sub">${formatStateSummary(counts.active, counts.inactive, counts.disabled)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Installed</div>
          <div class="stat-value">${counts.installed}</div>
          <div class="stat-sub">${formatStateSummary(counts.installedActive, counts.installedInactive, counts.installedDisabled)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Built-in</div>
          <div class="stat-value">${counts.builtin}</div>
          <div class="stat-sub">${formatStateSummary(counts.builtinActive, counts.builtinInactive, counts.builtinDisabled)}</div>
        </div>
      </div>
    ` : `
      <div class="stats-grid" style="grid-template-columns: 1fr;">
        <div class="stat-card">
          <div class="stat-label">Installed</div>
          <div class="stat-value">${counts.installed}</div>
          <div class="stat-sub">${formatStateSummary(counts.installedActive, counts.installedInactive, counts.installedDisabled)}</div>
        </div>
      </div>
    `;

    const sections = groups.map((group) => {
      const activeCount = group.items.filter((item) => item.isActive).length;
      const disabledCount = group.items.filter((item) => item.isDisabled).length;
      const inactiveCount = group.items.filter((item) => !item.isActive && !item.isDisabled).length;

      const cards = group.items.map((item) => {
        const icon = item.iconUri
          ? `<img class="icon" src="${item.iconUri.toString()}" alt="" />`
          : `<div class="icon fallback">🧩</div>`;

        const marketplaceUrl =
          `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(item.id)}`;
        const statusClass = item.isDisabled ? 'disabled' : item.isActive ? 'active' : 'inactive';
        const statusText = item.isDisabled ? 'Disabled' : item.isActive ? 'Active' : 'Idle';
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
      let groupOpenButton = '';
      if (group.isPack) {
        groupOpenButton = `<button class="group-open-btn" data-action="openExtension" data-value="${escapeHtml(group.id)}">Open</button>`;
      } else if (group.id.startsWith('publisher:')) {
        const publisher = group.id.slice('publisher:'.length);
        groupOpenButton = `<button class="group-open-btn" data-action="searchPublisher" data-value="${escapeHtml(publisher)}">Search</button>`;
      } else if (group.id.startsWith('category:')) {
        const category = group.id.slice('category:'.length);
        groupOpenButton = `<button class="group-open-btn" data-action="searchCategory" data-value="${escapeHtml(category)}">Search</button>`;
      }

      return `
        <div class="group-wrapper">
          ${groupOpenButton ? `<div class="group-open-wrap">${groupOpenButton}</div>` : ''}
          <details class="group" data-group-id="${escapeHtml(group.id)}" ${openAttr}>
            <summary>
              <div class="group-title-row">
                <div class="group-title-wrap">
                  <span class="group-title">${escapeHtml(group.label)}</span>
                  <span class="group-count">${group.items.length}</span>
                </div>
                <div class="group-desc">${escapeHtml(group.description || '')}</div>
                <div class="group-meta">${escapeHtml(formatStateSummary(activeCount, inactiveCount, disabledCount))}</div>
              </div>
            </summary>
            <div class="group-body">
              ${cards}
            </div>
          </details>
        </div>
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

    select {
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border-radius: 6px;
      padding: 4px 8px;
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

    .group-mode-control {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
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

    .group-wrapper {
      position: relative;
      margin-bottom: 10px;
    }

    .group {
      border: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      border-radius: 10px;
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

    .status-badge.disabled {
      background: color-mix(in srgb, var(--vscode-errorForeground, #c72e0f) 16%, transparent);
      color: var(--vscode-errorForeground, #c72e0f);
      border-color: color-mix(in srgb, var(--vscode-errorForeground, #c72e0f) 40%, transparent);
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

    .group-open-wrap {
      position: absolute;
      top: 10px;
      right: 12px;
      z-index: 1;
    }

    .group-open-btn {
      padding: 2px 8px;
      font-size: 11px;
      border-radius: 4px;
      transition: transform 80ms ease, background-color 80ms ease;
    }

    .group-open-btn:active {
      transform: scale(0.95);
      background: var(--vscode-button-hoverBackground);
    }

    .group-open-btn.opening {
      opacity: 0.6;
      pointer-events: none;
      animation: openingPulse 1s ease-in-out infinite;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <label class="group-mode-control">
      <span>Group</span>
      <select id="group-mode-select">
        <option value="pack"${groupMode === 'pack' ? ' selected' : ''}>Pack</option>
        <option value="publisher"${groupMode === 'publisher' ? ' selected' : ''}>Publisher</option>
        <option value="category"${groupMode === 'category' ? ' selected' : ''}>Category</option>
        <option value="category-all"${groupMode === 'category-all' ? ' selected' : ''}>Category (All)</option>
      </select>
    </label>
    <label class="group-mode-control">
      <input type="checkbox" id="show-builtin-checkbox"${showBuiltin ? ' checked' : ''} />
      <span>Built-in</span>
    </label>
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

    const groupModeSelect = document.getElementById('group-mode-select');
    if (groupModeSelect instanceof HTMLSelectElement) {
      groupModeSelect.addEventListener('change', () => {
        vscode.postMessage({
          type: 'setGroupMode',
          value: groupModeSelect.value
        });
      });
    }

    const showBuiltinCheckbox = document.getElementById('show-builtin-checkbox');
    if (showBuiltinCheckbox instanceof HTMLInputElement) {
      showBuiltinCheckbox.addEventListener('change', () => {
        vscode.postMessage({
          type: 'setShowBuiltin',
          value: showBuiltinCheckbox.checked ? 'true' : 'false'
        });
      });
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'setOpeningExtension') {
        if (typeof message.value !== 'string' || typeof message.opening !== 'boolean') {
          return;
        }

        setOpeningCard(message.value, message.opening);

        const groupBtn = document.querySelector('.group-open-btn[data-value="' + message.value + '"]');
        if (groupBtn instanceof HTMLElement) {
          if (message.opening) {
            groupBtn.classList.add('opening');
            groupBtn.textContent = 'Opening\u2026';
          } else {
            groupBtn.classList.remove('opening');
            groupBtn.textContent = 'Open';
          }
        }
      }

      if (message.type === 'resetGroupBtn') {
        const groupBtn = document.querySelector('.group-open-btn[data-value="' + message.value + '"]');
        if (groupBtn instanceof HTMLElement) {
          groupBtn.classList.remove('opening');
          const action = groupBtn.dataset.action;
          groupBtn.textContent = action === 'openExtension' ? 'Open' : 'Search';
        }
      }
    });

    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;

      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      if (target.classList.contains('group-open-btn')) {
        const action = target.dataset.action;
        const value = target.dataset.value;
        if (action && value) {
          target.classList.add('opening');
          target.textContent = action === 'openExtension' ? 'Opening\u2026' : 'Searching\u2026';
          vscode.postMessage({ type: action, value: value });
        }
        return;
      }

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

      if (target.classList.contains('group-open-btn')) return;

      const action = target.dataset.action;
      if (action) {
        event.preventDefault();
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
