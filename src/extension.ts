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
  isPreview: boolean;
  hasPreReleaseVersion: boolean;
  isPreReleaseVersion: boolean;
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
  preview?: boolean;
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
    hasPreReleaseVersion?: boolean;
    isPreReleaseVersion?: boolean;
    preRelease?: boolean;
  };
};

type InstalledExtensionRecord = {
  id: string;
  extensionPath?: string;
  version?: string;
  isBuiltin: boolean;
  publisherDisplayName?: string;
  hasPreReleaseVersion?: boolean;
  isPreReleaseVersion?: boolean;
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
  iconUri?: vscode.Uri;
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

type WebviewRenderPayload = {
  counts: SummaryCounts;
  statsHtml: string;
  sectionsHtml: string;
  expandedGroupIds: string[];
  selectedExtensionId?: string;
  groupMode: GroupMode;
  showBuiltin: boolean;
  showSearch: boolean;
};

export function activate(context: vscode.ExtensionContext): void {
  const provider = new InstalledExtensionsWebviewProvider(context);
  provider.syncMenuContext();

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
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByPackChecked', () => {
      provider.setGroupMode('pack');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByPublisher', () => {
      provider.setGroupMode('publisher');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByPublisherChecked', () => {
      provider.setGroupMode('publisher');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByCategory', () => {
      provider.setGroupMode('category');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByCategoryChecked', () => {
      provider.setGroupMode('category');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByCategoryAll', () => {
      provider.setGroupMode('category-all');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.groupByCategoryAllChecked', () => {
      provider.setGroupMode('category-all');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.toggleBuiltin', () => {
      provider.toggleBuiltin();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.toggleBuiltinUnchecked', () => {
      provider.toggleBuiltin();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.toggleBuiltinChecked', () => {
      provider.toggleBuiltin();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.toggleSearch', () => {
      provider.toggleSearch();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.toggleSearchUnchecked', () => {
      provider.toggleSearch();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('installedExtensionsManageStatus.toggleSearchChecked', () => {
      provider.toggleSearch();
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
  private static readonly groupModeContextKeys = {
    pack: 'installedExtensionsManageStatus.groupModePack',
    publisher: 'installedExtensionsManageStatus.groupModePublisher',
    category: 'installedExtensionsManageStatus.groupModeCategory',
    categoryAll: 'installedExtensionsManageStatus.groupModeCategoryAll',
  } as const;

  private static readonly showBuiltinContextKey = 'installedExtensionsManageStatus.showBuiltin';
  private static readonly showSearchContextKey = 'installedExtensionsManageStatus.showSearch';

  private view?: vscode.WebviewView;
  private expandedGroupIds = new Set<string>();
  private hasInitializedExpandedGroups = false;
  private selectedExtensionId?: string;
  private groupMode: GroupMode = 'pack';
  private showBuiltin = false;
  private showSearch = true;
  private hasRenderedHtml = false;
  private webviewReady = false;
  private pendingRenderPayload?: WebviewRenderPayload;
  private refreshHandle?: NodeJS.Timeout;
  private activityPollHandle?: NodeJS.Timeout;
  private lastRuntimeActivitySignature = '';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public syncMenuContext(): void {
    void this.updateMenuContext();
  }

  public dispose(): void {
    if (this.refreshHandle) {
      clearTimeout(this.refreshHandle);
      this.refreshHandle = undefined;
    }

    this.hasRenderedHtml = false;
    this.webviewReady = false;
    this.pendingRenderPayload = undefined;
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
    void this.updateMenuContext();
    if (this.view) {
      void this.render(this.view);
    }
  }

  public toggleBuiltin(): void {
    this.showBuiltin = !this.showBuiltin;
    this.expandedGroupIds.clear();
    void this.updateMenuContext();
    if (this.view) {
      void this.render(this.view);
    }
  }

  public toggleSearch(): void {
    this.showSearch = !this.showSearch;
    void this.updateMenuContext();
    if (this.view) {
      void this.render(this.view);
    }
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView
  ): Promise<void> {
    this.view = webviewView;
    this.hasRenderedHtml = false;
    this.webviewReady = false;
    this.pendingRenderPayload = undefined;

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

    webviewView.webview.onDidReceiveMessage(async (
      message: {
        type: string;
        value?: string;
        expandedIds?: string[];
        opening?: boolean;
      }
    ) => {
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

        case 'webviewReady':
          this.webviewReady = true;
          if (this.pendingRenderPayload) {
            const nextPayload = this.pendingRenderPayload;
            this.pendingRenderPayload = undefined;
            await webviewView.webview.postMessage({
              type: 'replaceViewContent',
              payload: nextPayload,
            });
          }
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
            await this.updateMenuContext();
            await this.render(webviewView);
          }
          break;

        case 'setShowBuiltin':
          this.showBuiltin = message.value === 'true';
          this.expandedGroupIds.clear();
          await this.updateMenuContext();
          await this.render(webviewView);
          break;

        case 'refresh':
          await this.render(webviewView);
          break;

        default:
          break;
      }
    });

    await this.updateMenuContext();
    await this.render(webviewView);
    this.updateActivityPolling();
  }

  private async updateMenuContext(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand(
        'setContext',
        InstalledExtensionsWebviewProvider.groupModeContextKeys.pack,
        this.groupMode === 'pack'
      ),
      vscode.commands.executeCommand(
        'setContext',
        InstalledExtensionsWebviewProvider.groupModeContextKeys.publisher,
        this.groupMode === 'publisher'
      ),
      vscode.commands.executeCommand(
        'setContext',
        InstalledExtensionsWebviewProvider.groupModeContextKeys.category,
        this.groupMode === 'category'
      ),
      vscode.commands.executeCommand(
        'setContext',
        InstalledExtensionsWebviewProvider.groupModeContextKeys.categoryAll,
        this.groupMode === 'category-all'
      ),
      vscode.commands.executeCommand(
        'setContext',
        InstalledExtensionsWebviewProvider.showBuiltinContextKey,
        this.showBuiltin
      ),
      vscode.commands.executeCommand(
        'setContext',
        InstalledExtensionsWebviewProvider.showSearchContextKey,
        this.showSearch
      ),
    ]);
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

    const payload = this.getRenderPayload(
      webview,
      filteredGroups,
      filteredCounts,
      this.expandedGroupIds,
      this.selectedExtensionId,
      this.groupMode,
      this.showBuiltin,
      this.showSearch
    );

    if (!this.hasRenderedHtml || webview.html.length === 0) {
      const nonce = getNonce();
      webview.html = this.getHtml(webview, nonce, payload);
      this.hasRenderedHtml = true;
      this.webviewReady = false;
      this.pendingRenderPayload = undefined;
      return;
    }

    if (!this.webviewReady) {
      this.pendingRenderPayload = payload;
      return;
    }

    const delivered = await webview.postMessage({
      type: 'replaceViewContent',
      payload,
    });

    if (!delivered) {
      this.pendingRenderPayload = payload;
    }
  }

  private getRenderPayload(
    webview: vscode.Webview,
    groups: PackGroup[],
    counts: SummaryCounts,
    expandedGroupIds: Set<string>,
    selectedExtensionId?: string,
    groupMode: GroupMode = 'pack',
    showBuiltin = true,
    showSearch = true
  ): WebviewRenderPayload {
    const { statsHtml, sectionsHtml } = this.getViewMarkup(
      webview,
      groups,
      counts,
      expandedGroupIds,
      selectedExtensionId
    );

    return {
      counts,
      statsHtml,
      sectionsHtml,
      expandedGroupIds: [...expandedGroupIds],
      selectedExtensionId,
      groupMode,
      showBuiltin,
      showSearch,
    };
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
        hasPreReleaseVersion: entry.hasPreReleaseVersion,
        isPreReleaseVersion: entry.isPreReleaseVersion,
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
        hasPreReleaseVersion: false,
        isPreReleaseVersion: false,
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
      hasPreReleaseVersion?: boolean;
      isPreReleaseVersion?: boolean;
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
      isPreview: options.packageJson?.preview === true,
      hasPreReleaseVersion: options.hasPreReleaseVersion === true || options.isPreReleaseVersion === true,
      isPreReleaseVersion: options.isPreReleaseVersion === true,
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
          hasPreReleaseVersion: entry.metadata?.hasPreReleaseVersion === true,
          isPreReleaseVersion: entry.metadata?.isPreReleaseVersion === true || entry.metadata?.preRelease === true,
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
    const packGroups: PackGroup[] = [];

    const packExtensions = items
      .map((item) => {
        return {
          id: item.id,
          label: item.displayName || item.id,
          description: item.description,
          iconUri: item.iconUri,
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
        packGroups.push({
          id: pack.id,
          label: pack.label,
          description: pack.description,
          items: packItems.sort((a, b) => a.id.localeCompare(b.id)),
          isPack: true,
          iconUri: pack.iconUri,
        });
      }
    }

    const notInPack = items.filter(
      (item) => !assigned.has(item.id.toLowerCase()) && !packExtensions.some((pack) => pack.id === item.id)
    );

    const installed = notInPack.filter((item) => !item.isBuiltin);
    const builtin = notInPack.filter((item) => item.isBuiltin);

    if (installed.length > 0) {
      packGroups.unshift({
        id: 'other-installed',
        label: 'Standalone Extensions',
        description: 'Installed extensions not included in any installed extension pack',
        items: installed.sort((a, b) => a.id.localeCompare(b.id)),
        isPack: false,
      });
    }

    if (builtin.length > 0) {
      packGroups.unshift({
        id: 'builtin',
        label: 'Built-in Extensions',
        description: 'Built-in extensions not included in any installed extension pack',
        items: builtin.sort((a, b) => a.id.localeCompare(b.id)),
        isPack: false,
      });
    }

    return packGroups;
  }

  private getGroupIconMarkup(group: PackGroup): string {
    if (group.iconUri) {
      return `<img class="group-icon" src="${group.iconUri.toString()}" alt="" />`;
    }

    if (group.id === 'other-installed') {
      return `
        <span class="group-icon group-icon-symbolic" aria-hidden="true">
          <svg class="group-icon-svg" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="4" height="4" rx="1"></rect>
            <rect x="10" y="2" width="4" height="4" rx="1"></rect>
            <rect x="2" y="10" width="4" height="4" rx="1"></rect>
            <rect x="10" y="10" width="4" height="4" rx="1"></rect>
          </svg>
        </span>
      `;
    }

    if (group.id === 'builtin') {
      return `
        <span class="group-icon group-icon-symbolic" aria-hidden="true">
          <svg class="group-icon-svg" viewBox="0 0 16 16" fill="none">
            <path d="M8 2.2 3.2 4.3v3.6c0 3 2.1 5.7 4.8 6.5 2.7-.8 4.8-3.5 4.8-6.5V4.3L8 2.2Z"></path>
            <path d="m6.6 8 1 1 2-2.2"></path>
          </svg>
        </span>
      `;
    }

    if (group.id.startsWith('builtin-publisher:')) {
      return `
        <span class="group-icon group-icon-symbolic" aria-hidden="true">
          <svg class="group-icon-svg" viewBox="0 0 16 16" fill="none">
            <path d="M8 2.2 3.2 4.3v3.6c0 3 2.1 5.7 4.8 6.5 2.7-.8 4.8-3.5 4.8-6.5V4.3L8 2.2Z"></path>
            <path d="m6.6 8 1 1 2-2.2"></path>
          </svg>
        </span>
      `;
    }

    if (group.id.startsWith('publisher:')) {
      return `
        <span class="group-icon group-icon-symbolic" aria-hidden="true">
          <svg class="group-icon-svg" viewBox="0 0 16 16" fill="none">
            <path d="M3 13.2h10"></path>
            <path d="M4.3 13V6.3"></path>
            <path d="M8 13V6.3"></path>
            <path d="M11.7 13V6.3"></path>
            <path d="M2.5 6.2h11"></path>
            <path d="M8 2.5 2.8 5.2h10.4L8 2.5Z"></path>
          </svg>
        </span>
      `;
    }

    if (group.id.startsWith('category:')) {
      return `
        <span class="group-icon group-icon-symbolic" aria-hidden="true">
          <svg class="group-icon-svg" viewBox="0 0 16 16" fill="none">
            <path d="M7 3.2H3.8c-.7 0-1.3.6-1.3 1.3v3.2c0 .4.2.8.5 1.1l3.7 3.7c.5.5 1.3.5 1.8 0l4-4c.5-.5.5-1.3 0-1.8L8.1 3.6C7.8 3.3 7.4 3.2 7 3.2Z"></path>
            <path d="M5.2 5.4h.1"></path>
          </svg>
        </span>
      `;
    }

    return '';
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

  private isSyntheticPublisher(publisher: string): boolean {
    const normalized = publisher.trim().toLowerCase();
    return normalized === ''
      || normalized === 'unknown'
      || normalized === 'undefined'
      || normalized === 'undefined_publisher'
      || normalized === 'undefined publisher';
  }

  private getPublisherDisplayLabel(
    publisher: string,
    displayNames: Map<string, string>
  ): string {
    if (this.isSyntheticPublisher(publisher)) {
      return 'Unknown Publisher';
    }

    return displayNames.get(publisher.toLowerCase()) ?? publisher;
  }

  private getPublisherGroupPublisherId(groupId: string): string | undefined {
    if (groupId.startsWith('publisher:')) {
      return groupId.slice('publisher:'.length);
    }

    if (groupId.startsWith('builtin-publisher:')) {
      return groupId.slice('builtin-publisher:'.length);
    }

    return undefined;
  }

  private getPublisherGroups(items: ExtensionItem[]): PackGroup[] {
    const displayNames = this.getPublisherDisplayNames();
    const groupsByPublisher = new Map<string, ExtensionItem[]>();

    for (const item of items) {
      const publisher = item.publisher || 'unknown';
      const existing = groupsByPublisher.get(publisher);
      if (existing) {
        existing.push(item);
      } else {
        groupsByPublisher.set(publisher, [item]);
      }
    }

    const sortedGroups = [...groupsByPublisher.entries()].sort(([a], [b]) => {
      const aIsSynthetic = this.isSyntheticPublisher(a);
      const bIsSynthetic = this.isSyntheticPublisher(b);
      if (aIsSynthetic !== bIsSynthetic) {
        return aIsSynthetic ? -1 : 1;
      }

      const aName = this.getPublisherDisplayLabel(a, displayNames);
      const bName = this.getPublisherDisplayLabel(b, displayNames);
      return aName.localeCompare(bName);
    });

    const builtinOnlyPublisherGroups: PackGroup[] = [];
    const publisherGroups: PackGroup[] = [];

    for (const [publisher, groupedItems] of sortedGroups) {
      const displayName = this.getPublisherDisplayLabel(publisher, displayNames);
      const installedCount = groupedItems.filter((item) => !item.isBuiltin).length;
      const builtinCount = groupedItems.length - installedCount;
      const descriptionParts: string[] = [];
      const isSyntheticPublisher = this.isSyntheticPublisher(publisher);
      const normalizedDisplayName = displayName.trim().toLowerCase();
      const normalizedPublisher = publisher.trim().toLowerCase();

      if (isSyntheticPublisher) {
        descriptionParts.push('No publisher metadata');
      }

      const sortedItems = groupedItems.sort((a, b) => a.id.localeCompare(b.id));
      if (installedCount === 0) {
        descriptionParts.push(`${builtinCount} built-in`);
        builtinOnlyPublisherGroups.push({
          id: `builtin-publisher:${publisher}`,
          label: displayName,
          description: descriptionParts.join(' · '),
          items: sortedItems,
          isPack: false,
        });
        continue;
      }

      descriptionParts.push(`${installedCount} installed`);
      if (builtinCount > 0) {
        descriptionParts.push(`${builtinCount} built-in`);
      }

      publisherGroups.push({
        id: `publisher:${publisher}`,
        label: displayName,
        description: descriptionParts.join(' · '),
        items: sortedItems,
        isPack: false,
      });
    }

    return [...builtinOnlyPublisherGroups, ...publisherGroups];
  }

  private getCategoryDisplayLabel(category: string): string {
    return this.isSyntheticCategory(category) ? 'Uncategorized Extensions' : category;
  }

  private isSyntheticCategory(category: string): boolean {
    return category === 'Uncategorized';
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
      .sort(([a], [b]) => {
        const aIsSynthetic = this.isSyntheticCategory(a);
        const bIsSynthetic = this.isSyntheticCategory(b);
        if (aIsSynthetic !== bIsSynthetic) {
          return aIsSynthetic ? -1 : 1;
        }

        return this.getCategoryDisplayLabel(a).localeCompare(this.getCategoryDisplayLabel(b));
      })
      .map(([category, categoryItems]) => {
        const installedCount = categoryItems.filter((item) => !item.isBuiltin).length;
        const builtinCount = categoryItems.length - installedCount;
        const descriptionParts: string[] = [];
        const isSyntheticCategory = this.isSyntheticCategory(category);

        if (isSyntheticCategory) {
          descriptionParts.push('No declared category');
        }

        if (installedCount > 0) {
          descriptionParts.push(`${installedCount} installed`);
        }

        if (builtinCount > 0) {
          descriptionParts.push(`${builtinCount} built-in`);
        }

        return {
          id: `category:${category}`,
          label: this.getCategoryDisplayLabel(category),
          description: descriptionParts.join(' · '),
          items: categoryItems.sort((a, b) => a.id.localeCompare(b.id)),
          isPack: false,
        };
      });
  }

  private getViewMarkup(
    webview: vscode.Webview,
    groups: PackGroup[],
    counts: SummaryCounts,
    expandedGroupIds: Set<string>,
    selectedExtensionId?: string
  ): { statsHtml: string; sectionsHtml: string } {
    const formatStateSummary = (activeCount: number, idleCount: number, disabledCount: number): string => {
      const parts = [`Active ${activeCount}`, `Idle ${idleCount}`];
      if (disabledCount > 0) {
        parts.push(`Disabled ${disabledCount}`);
      }

      return parts.join(' · ');
    };

    const getGroupDescriptionState = (group: PackGroup): { mode: 'static' | 'counts'; prefix: string } => {
      if (group.isPack || group.id === 'other-installed' || group.id === 'builtin') {
        return { mode: 'static', prefix: '' };
      }

      const publisher = this.getPublisherGroupPublisherId(group.id);
      if (publisher) {
        return {
          mode: 'counts',
          prefix: this.isSyntheticPublisher(publisher) ? 'No publisher metadata' : '',
        };
      }

      if (group.id.startsWith('category:')) {
        const category = group.id.slice('category:'.length);
        return {
          mode: 'counts',
          prefix: this.isSyntheticCategory(category) ? 'No declared category' : '',
        };
      }

      return { mode: 'static', prefix: '' };
    };

    const renderStatCard = (
      key: 'total' | 'installed' | 'builtin',
      label: string,
      value: number,
      activeCount: number,
      idleCount: number,
      disabledCount: number
    ): string => `
      <div class="stat-card" data-stat-card="${key}">
        <div class="stat-label">${label}</div>
        <div class="stat-value" data-stat-value="${key}">${value}</div>
        <div class="stat-sub" data-stat-sub="${key}">${formatStateSummary(activeCount, idleCount, disabledCount)}</div>
      </div>
    `;

    const statsHtml = this.showBuiltin ? `
      <div class="stats-grid" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
        ${renderStatCard('total', 'Total', counts.total, counts.active, counts.inactive, counts.disabled)}
        ${renderStatCard(
          'installed',
          'Installed',
          counts.installed,
          counts.installedActive,
          counts.installedInactive,
          counts.installedDisabled
        )}
        ${renderStatCard(
          'builtin',
          'Built-in',
          counts.builtin,
          counts.builtinActive,
          counts.builtinInactive,
          counts.builtinDisabled
        )}
      </div>
    ` : `
      <div class="stats-grid" style="grid-template-columns: 1fr;">
        ${renderStatCard(
          'installed',
          'Installed',
          counts.installed,
          counts.installedActive,
          counts.installedInactive,
          counts.installedDisabled
        )}
      </div>
    `;

    const sections = groups.map((group) => {
      const activeCount = group.items.filter((item) => item.isActive).length;
      const disabledCount = group.items.filter((item) => item.isDisabled).length;
      const inactiveCount = group.items.filter((item) => !item.isActive && !item.isDisabled).length;

      const cards = group.items.map((item) => {
        const cornerBadges: Array<{ label: string; kind: string }> = [];
        if (item.extensionPack.length > 0) {
          cornerBadges.push({ label: 'Pack', kind: 'pack' });
        }

        if (item.isPreview || item.isPreReleaseVersion) {
          cornerBadges.push({ label: 'Preview', kind: 'preview' });
        } else if (item.hasPreReleaseVersion && !item.isBuiltin) {
          cornerBadges.push({ label: 'Release', kind: 'release' });
        }

        const iconBody = item.iconUri
          ? `<img class="icon" src="${item.iconUri.toString()}" alt="" />`
          : `<div class="icon fallback">🧩</div>`;
        const iconBadges = cornerBadges.length > 0
          ? `
            <span class="icon-corner-badges">
              ${cornerBadges.map((badge) =>
                `<span class="icon-corner-badge ${badge.kind}">${escapeHtml(badge.label)}</span>`
              ).join('')}
            </span>
          `
          : '';
        const icon = `
          <div class="icon-wrap">
            ${iconBody}
            ${iconBadges}
          </div>
        `;

        const marketplaceUrl =
          `https://marketplace.visualstudio.com/items?itemName=${encodeURIComponent(item.id)}`;
        const statusClass = item.isDisabled ? 'disabled' : item.isActive ? 'active' : 'inactive';
        const statusText = item.isDisabled ? 'Disabled' : item.isActive ? 'Active' : 'Idle';
        const kindText = item.isBuiltin ? 'Built-in' : '';
        const searchText = [
          item.id,
          item.name,
          item.displayName,
          item.publisher,
          item.description,
          item.categories.join(' '),
        ]
          .filter((value) => value.trim().length > 0)
          .join(' ')
          .replace(/\s+/g, ' ')
          .toLowerCase();

        return `
          <article
            class="card ${selectedExtensionId === item.id ? 'selected' : ''}"
            data-id="${escapeHtml(item.id)}"
            data-search="${escapeHtml(searchText)}"
            data-active="${item.isActive ? 'true' : 'false'}"
            data-disabled="${item.isDisabled ? 'true' : 'false'}"
            data-builtin="${item.isBuiltin ? 'true' : 'false'}"
            role="button"
            tabindex="0"
            aria-label="Open ${escapeHtml(item.id)}"
          >
            <div class="card-main">
              ${icon}
              <div class="meta">
                <div class="title-row">
                  <span class="card-title">${escapeHtml(item.displayName)}</span>
                  ${kindText ? `<span class="badge kind-badge">${escapeHtml(kindText)}</span>` : ''}
                  <span class="badge status-badge ${statusClass}">${escapeHtml(statusText)}</span>
                  <span class="badge opening-badge" hidden>Requested...</span>
                </div>
                <div class="identifier">${escapeHtml(item.id)}</div>
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
      const groupIcon = this.getGroupIconMarkup(group);
      const groupCount = group.items.length;
      const groupStateSummary = formatStateSummary(activeCount, inactiveCount, disabledCount);
      const useIconCountBadge = !!groupIcon;
      const groupIconMarkup = useIconCountBadge ? `
        <span class="group-icon-wrap">
          ${groupIcon}
          <span class="group-icon-count" data-group-count data-group-count-static="${groupCount}">${groupCount}</span>
        </span>
      ` : groupIcon;
      let groupOpenButton = '';
      if (group.isPack) {
        groupOpenButton = `<button class="group-open-btn" data-action="openExtension" data-value="${escapeHtml(group.id)}">Show</button>`;
      } else {
        const publisher = this.getPublisherGroupPublisherId(group.id);
        if (publisher && !this.isSyntheticPublisher(publisher)) {
          groupOpenButton = `<button class="group-open-btn" data-action="searchPublisher" data-value="${escapeHtml(publisher)}">Search</button>`;
        } else if (group.id.startsWith('category:')) {
          const category = group.id.slice('category:'.length);
          if (!this.isSyntheticCategory(category)) {
            groupOpenButton = `<button class="group-open-btn" data-action="searchCategory" data-value="${escapeHtml(category)}">Search</button>`;
          }
        }
      }

      const groupTitle = (() => {
        const publisher = this.getPublisherGroupPublisherId(group.id);
        if (!publisher) {
          return `<span class="group-title">${escapeHtml(group.label)}</span>`;
        }

        if (!this.isSyntheticPublisher(publisher)) {
          const normalizedLabel = group.label.trim().toLowerCase();
          const normalizedPublisher = publisher.trim().toLowerCase();
          if (
            normalizedLabel === normalizedPublisher
            || normalizedLabel.endsWith(`: ${normalizedPublisher}`)
          ) {
            return `<span class="group-title">${escapeHtml(group.label)}</span>`;
          }
        }

        if (this.isSyntheticPublisher(publisher)) {
          return `<span class="group-title">${escapeHtml(group.label)}</span>`;
        }

        return `
          <span class="group-title">${escapeHtml(group.label)}</span>
          <span class="group-title-id">${escapeHtml(publisher)}</span>
        `;
      })();
      const groupDescriptionState = getGroupDescriptionState(group);

      return `
        <div class="group-wrapper">
          ${groupOpenButton ? `<div class="group-open-wrap">${groupOpenButton}</div>` : ''}
          <details class="group" data-group-id="${escapeHtml(group.id)}" ${openAttr}>
            <summary>
              <div class="group-summary-main">
                ${groupIconMarkup}
                <div class="group-title-row">
                  <div class="group-title-wrap">
                    ${groupTitle}
                    ${useIconCountBadge ? '' : `<span class="group-count" data-group-count data-group-count-static="${groupCount}">${groupCount}</span>`}
                  </div>
                  <div
                    class="group-desc"
                    data-group-desc
                    data-group-desc-mode="${groupDescriptionState.mode}"
                    data-group-desc-prefix="${escapeHtml(groupDescriptionState.prefix)}"
                    data-group-desc-static="${escapeHtml(group.description || '')}"
                  >${escapeHtml(group.description || '')}</div>
                  <div class="group-meta" data-group-meta data-group-meta-static="${escapeHtml(groupStateSummary)}">${escapeHtml(groupStateSummary)}</div>
                </div>
              </div>
            </summary>
            <div class="group-body">
              ${cards}
            </div>
          </details>
        </div>
      `;
    }).join('\n');

    return {
      statsHtml,
      sectionsHtml: sections,
    };
  }

  private getHtml(
    webview: vscode.Webview,
    nonce: string,
    initialRenderPayload: WebviewRenderPayload
  ): string {
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
      display: grid;
      gap: 6px;
      margin-bottom: 12px;
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      padding-bottom: 8px;
      z-index: 2;
    }

    .search-control {
      display: grid;
      gap: 6px;
    }

    .search-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
    }

    .search-input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      background: var(--vscode-input-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      border-radius: 6px;
      padding: 7px 10px;
      font: inherit;
    }

    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
    }

    .search-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .search-meta {
      min-height: 16px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .search-empty {
      margin: 0 0 12px;
      padding: 10px 12px;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)) 84%, transparent);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
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

    .group-wrapper {
      position: relative;
      margin-bottom: 10px;
    }

    .group-wrapper.search-open .group:not([open]) > summary {
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
    }

    .group-wrapper.search-open .group:not([open]) > .group-body {
      display: grid;
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
      padding: 10px 64px 10px 12px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 80%, transparent);
    }

    summary::-webkit-details-marker {
      display: none;
    }

    .group-summary-main {
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }

    .group-icon {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      object-fit: contain;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      flex: 0 0 auto;
    }

    .group-icon-wrap {
      position: relative;
      display: inline-flex;
      flex: 0 0 auto;
    }

    .group-icon-count {
      position: absolute;
      left: -5px;
      bottom: -5px;
      min-width: 14px;
      height: 14px;
      padding: 0 3px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border: 1px solid var(--vscode-sideBar-background);
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      box-sizing: border-box;
      pointer-events: none;
    }

    .group-icon-fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }

    .group-icon-symbolic {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--vscode-textLink-foreground);
      background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, var(--vscode-editor-background));
    }

    .group-icon-svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      stroke-width: 1.3;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .group-title-row {
      display: flex;
      flex: 1;
      min-width: 0;
      flex-direction: column;
      gap: 4px;
    }

    .group-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      flex-wrap: wrap;
    }

    .group-title-id {
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 11px;
      font-weight: 500;
      padding: 1px 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent);
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

    .icon-wrap {
      position: relative;
      width: 36px;
      height: 36px;
      flex: 0 0 36px;
    }

    .icon-corner-badges {
      position: absolute;
      top: -6px;
      left: -6px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 3px;
      pointer-events: none;
      z-index: 1;
    }

    .icon-corner-badge {
      display: inline-flex;
      align-items: center;
      min-height: 14px;
      padding: 0 5px;
      border-radius: 4px;
      border: 1px solid var(--vscode-sideBar-background);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 8px;
      font-weight: 700;
      line-height: 1;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
      white-space: nowrap;
      box-sizing: border-box;
    }

    .icon-corner-badge.pack {
      background: var(--vscode-textLink-foreground);
      color: var(--vscode-editor-background);
    }

    .icon-corner-badge.preview {
      background: var(--vscode-editorWarning-foreground, #a15c00);
      color: var(--vscode-editor-background);
    }

    .icon-corner-badge.release {
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 28%, var(--vscode-sideBar-background));
      color: var(--vscode-foreground);
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

    .identifier,
    .desc,
    .version {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .identifier {
      margin-top: 4px;
      font-weight: 500;
      opacity: 0.75;
      font-size: 0.85em;
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

    [hidden] {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="toolbar"${initialRenderPayload.showSearch ? '' : ' hidden'}>
    <label class="search-control" for="extension-search-input">
      <span class="search-label">Search Extensions</span>
      <input
        class="search-input"
        id="extension-search-input"
        type="search"
        placeholder="Search by name, ID, publisher, or category"
        spellcheck="false"
      />
    </label>
    <div class="search-meta" id="search-meta" aria-live="polite"></div>
  </div>

  <div id="stats-root">${initialRenderPayload.statsHtml}</div>
  <div class="search-empty" id="search-empty" hidden>No extensions match this search.</div>
  <div id="groups-root">${initialRenderPayload.sectionsHtml}</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialRenderPayload = ${JSON.stringify(initialRenderPayload)};
    let currentExpandedGroupIds = Array.isArray(initialRenderPayload.expandedGroupIds)
      ? initialRenderPayload.expandedGroupIds.filter((value) => typeof value === 'string')
      : [];
    let currentGroupMode = initialRenderPayload.groupMode;
    let currentShowBuiltin = initialRenderPayload.showBuiltin === true;
    let currentShowSearch = initialRenderPayload.showSearch === true;
    let currentCounts = initialRenderPayload.counts;
    const initialViewState = vscode.getState();
    const persistedExpandedGroupIds = initialViewState
      && initialViewState.groupMode === currentGroupMode
      && initialViewState.showBuiltin === currentShowBuiltin
      && Array.isArray(initialViewState.expandedGroupIds)
        ? initialViewState.expandedGroupIds.filter((value) => typeof value === 'string')
        : currentExpandedGroupIds;
    currentExpandedGroupIds = persistedExpandedGroupIds;
    let selectedCardId = typeof initialViewState?.selectedCardId === 'string'
      ? initialViewState.selectedCardId
      : (typeof initialRenderPayload.selectedExtensionId === 'string'
        ? initialRenderPayload.selectedExtensionId
        : '');
    let searchQuery = typeof initialViewState?.searchQuery === 'string'
      ? initialViewState.searchQuery
      : '';
    let searchInputFocused = currentShowSearch && initialViewState?.searchInputFocused === true;
    let searchSelectionStart = Number.isInteger(initialViewState?.searchSelectionStart)
      ? initialViewState.searchSelectionStart
      : searchQuery.length;
    let searchSelectionEnd = Number.isInteger(initialViewState?.searchSelectionEnd)
      ? initialViewState.searchSelectionEnd
      : searchSelectionStart;
    const toolbar = document.querySelector('.toolbar');
    const statsRoot = document.getElementById('stats-root');
    const groupsRoot = document.getElementById('groups-root');
    const openingCardIds = new Set();
    const openingCardTimers = new Map();
    const openingIndicatorDelayMs = 160;
    let suppressCardClick = false;

    function getExpandedGroupIds() {
      return Array.from(
        document.querySelectorAll('details.group[open][data-group-id]')
      ).map((el) => el.getAttribute('data-group-id')).filter(Boolean);
    }

    function persistViewState(expandedGroupIds = getExpandedGroupIds(), overrides = {}) {
      vscode.setState({
        selectedCardId,
        expandedGroupIds,
        groupMode: currentGroupMode,
        showBuiltin: currentShowBuiltin,
        showSearch: currentShowSearch,
        searchQuery,
        searchInputFocused,
        searchSelectionStart,
        searchSelectionEnd,
        ...overrides
      });
    }

    function normalizeSearchQuery(value) {
      return value.trim().toLowerCase();
    }

    function syncSearchInputState(input, focused = document.activeElement === input) {
      if (!(input instanceof HTMLInputElement)) {
        return;
      }

      searchInputFocused = focused;
      const valueLength = input.value.length;
      searchSelectionStart = typeof input.selectionStart === 'number'
        ? Math.min(input.selectionStart, valueLength)
        : valueLength;
      searchSelectionEnd = typeof input.selectionEnd === 'number'
        ? Math.min(input.selectionEnd, valueLength)
        : searchSelectionStart;
      persistViewState();
    }

    function restoreSearchInput(input) {
      if (!(input instanceof HTMLInputElement)) {
        return;
      }

      input.value = searchQuery;
      const valueLength = input.value.length;
      const selectionStart = Math.min(searchSelectionStart, valueLength);
      const selectionEnd = Math.min(searchSelectionEnd, valueLength);

      if (currentShowSearch && searchInputFocused) {
        input.focus();
      }

      input.setSelectionRange(selectionStart, selectionEnd);
    }

    function createEmptySummary() {
      return {
        total: 0,
        active: 0,
        inactive: 0,
        disabled: 0,
        installed: 0,
        installedActive: 0,
        installedInactive: 0,
        installedDisabled: 0,
        builtin: 0,
        builtinActive: 0,
        builtinInactive: 0,
        builtinDisabled: 0
      };
    }

    function summarizeCard(summary, card) {
      const isBuiltin = card.dataset.builtin === 'true';
      const isDisabled = card.dataset.disabled === 'true';
      const isActive = !isDisabled && card.dataset.active === 'true';

      summary.total += 1;
      if (isDisabled) {
        summary.disabled += 1;
      } else if (isActive) {
        summary.active += 1;
      } else {
        summary.inactive += 1;
      }

      if (isBuiltin) {
        summary.builtin += 1;
        if (isDisabled) {
          summary.builtinDisabled += 1;
        } else if (isActive) {
          summary.builtinActive += 1;
        } else {
          summary.builtinInactive += 1;
        }
      } else {
        summary.installed += 1;
        if (isDisabled) {
          summary.installedDisabled += 1;
        } else if (isActive) {
          summary.installedActive += 1;
        } else {
          summary.installedInactive += 1;
        }
      }

      return summary;
    }

    function formatCountDescription(prefix, installedCount, builtinCount) {
      const parts = [];
      if (prefix) {
        parts.push(prefix);
      }

      if (installedCount > 0) {
        parts.push(installedCount + ' installed');
      }

      if (builtinCount > 0) {
        parts.push(builtinCount + ' built-in');
      }

      return parts.join(' · ');
    }

    function updateStatCard(key, totalCount, activeCount, idleCount, disabledCount) {
      const valueNode = document.querySelector('[data-stat-value="' + key + '"]');
      if (valueNode instanceof HTMLElement) {
        valueNode.textContent = String(totalCount);
      }

      const subNode = document.querySelector('[data-stat-sub="' + key + '"]');
      if (subNode instanceof HTMLElement) {
        const parts = ['Active ' + activeCount, 'Idle ' + idleCount];
        if (disabledCount > 0) {
          parts.push('Disabled ' + disabledCount);
        }

        subNode.textContent = parts.join(' · ');
      }
    }

    function restoreBaseStats() {
      updateStatCard(
        'installed',
        currentCounts.installed,
        currentCounts.installedActive,
        currentCounts.installedInactive,
        currentCounts.installedDisabled
      );
      if (currentShowBuiltin) {
        updateStatCard('total', currentCounts.total, currentCounts.active, currentCounts.inactive, currentCounts.disabled);
        updateStatCard(
          'builtin',
          currentCounts.builtin,
          currentCounts.builtinActive,
          currentCounts.builtinInactive,
          currentCounts.builtinDisabled
        );
      }
    }

    function restoreGroupSummary(wrapper) {
      wrapper.querySelectorAll('[data-group-count]').forEach((element) => {
        if (element instanceof HTMLElement) {
          element.textContent = element.dataset.groupCountStatic ?? '';
        }
      });

      const groupMeta = wrapper.querySelector('[data-group-meta]');
      if (groupMeta instanceof HTMLElement) {
        groupMeta.textContent = groupMeta.dataset.groupMetaStatic ?? '';
      }

      const groupDesc = wrapper.querySelector('[data-group-desc]');
      if (groupDesc instanceof HTMLElement) {
        groupDesc.textContent = groupDesc.dataset.groupDescStatic ?? '';
      }
    }

    function updateGroupSummary(wrapper, visibleCards) {
      const visibleCount = visibleCards.length;
      const groupSummary = createEmptySummary();
      visibleCards.forEach((card) => {
        summarizeCard(groupSummary, card);
      });

      wrapper.querySelectorAll('[data-group-count]').forEach((element) => {
        if (element instanceof HTMLElement) {
          element.textContent = String(visibleCount);
        }
      });

      const groupMeta = wrapper.querySelector('[data-group-meta]');
      if (groupMeta instanceof HTMLElement) {
        const parts = ['Active ' + groupSummary.active, 'Idle ' + groupSummary.inactive];
        if (groupSummary.disabled > 0) {
          parts.push('Disabled ' + groupSummary.disabled);
        }

        groupMeta.textContent = parts.join(' · ');
      }

      const groupDesc = wrapper.querySelector('[data-group-desc]');
      if (groupDesc instanceof HTMLElement) {
        if (groupDesc.dataset.groupDescMode === 'counts') {
          groupDesc.textContent = formatCountDescription(
            groupDesc.dataset.groupDescPrefix ?? '',
            groupSummary.installed,
            groupSummary.builtin
          );
        } else {
          groupDesc.textContent = groupDesc.dataset.groupDescStatic ?? '';
        }
      }
    }

    function updateVisibleStats(visibleCards) {
      const visibleExtensionIds = new Set();
      const visibleSummary = createEmptySummary();

      visibleCards.forEach((card) => {
        const id = card.dataset.id;
        if (!id || visibleExtensionIds.has(id)) {
          return;
        }

        visibleExtensionIds.add(id);
        summarizeCard(visibleSummary, card);
      });

      updateStatCard('total', visibleSummary.total, visibleSummary.active, visibleSummary.inactive, visibleSummary.disabled);
      updateStatCard(
        'installed',
        visibleSummary.installed,
        visibleSummary.installedActive,
        visibleSummary.installedInactive,
        visibleSummary.installedDisabled
      );

      if (currentShowBuiltin) {
        updateStatCard(
          'builtin',
          visibleSummary.builtin,
          visibleSummary.builtinActive,
          visibleSummary.builtinInactive,
          visibleSummary.builtinDisabled
        );
      }

      return visibleSummary.total;
    }

    function restoreExpandedGroups() {
      const desiredIds = new Set(currentExpandedGroupIds);
      document.querySelectorAll('details.group[data-group-id]').forEach((details) => {
        if (!(details instanceof HTMLDetailsElement)) {
          return;
        }

        const groupId = details.getAttribute('data-group-id');
        details.open = !!groupId && desiredIds.has(groupId);
      });
    }

    function applySelectedCard() {
      document.querySelectorAll('.card.selected').forEach((el) => {
        el.classList.remove('selected');
      });

      if (!selectedCardId) {
        return;
      }

      const next = document.querySelector('.card[data-id="' + selectedCardId + '"]');
      if (next) {
        next.classList.add('selected');
      }
    }

    function sendExpandedGroups() {
      const expandedIds = getExpandedGroupIds();
      currentExpandedGroupIds = expandedIds;
      persistViewState(expandedIds);

      vscode.postMessage({
        type: 'setExpandedGroups',
        expandedIds
      });
    }

    function bindGroupToggleListeners() {
      document.querySelectorAll('details.group').forEach((details) => {
        if (!(details instanceof HTMLDetailsElement) || details.dataset.toggleBound === 'true') {
          return;
        }

        details.addEventListener('toggle', sendExpandedGroups);
        details.dataset.toggleBound = 'true';
      });
    }

    function getDirectGroupOpenWrap(wrapper) {
      if (!(wrapper instanceof HTMLElement)) {
        return undefined;
      }

      return Array.from(wrapper.children).find((child) =>
        child instanceof HTMLElement && child.classList.contains('group-open-wrap')
      );
    }

    function patchGroupWrapper(existingWrapper, incomingWrapper) {
      if (!(existingWrapper instanceof HTMLElement) || !(incomingWrapper instanceof HTMLElement)) {
        return;
      }

      const existingOpenWrap = getDirectGroupOpenWrap(existingWrapper);
      const incomingOpenWrap = getDirectGroupOpenWrap(incomingWrapper);

      if (existingOpenWrap instanceof HTMLElement && incomingOpenWrap instanceof HTMLElement) {
        existingOpenWrap.innerHTML = incomingOpenWrap.innerHTML;
      } else if (existingOpenWrap instanceof HTMLElement && !incomingOpenWrap) {
        existingOpenWrap.remove();
      } else if (!existingOpenWrap && incomingOpenWrap instanceof HTMLElement) {
        existingWrapper.insertBefore(incomingOpenWrap, existingWrapper.firstChild ?? null);
      }

      const existingDetails = existingWrapper.querySelector('details.group[data-group-id]');
      const incomingDetails = incomingWrapper.querySelector('details.group[data-group-id]');
      if (!(existingDetails instanceof HTMLDetailsElement) || !(incomingDetails instanceof HTMLDetailsElement)) {
        return;
      }

      const incomingSummary = incomingDetails.querySelector('summary');
      const existingSummary = existingDetails.querySelector('summary');
      if (existingSummary instanceof HTMLElement && incomingSummary instanceof HTMLElement) {
        existingSummary.innerHTML = incomingSummary.innerHTML;
      }

      const incomingBody = incomingDetails.querySelector('.group-body');
      const existingBody = existingDetails.querySelector('.group-body');
      if (existingBody instanceof HTMLElement && incomingBody instanceof HTMLElement) {
        existingBody.innerHTML = incomingBody.innerHTML;
      }
    }

    function syncGroupWrappers(nextSectionsHtml) {
      if (!(groupsRoot instanceof HTMLElement)) {
        return new Set();
      }

      const template = document.createElement('template');
      template.innerHTML = typeof nextSectionsHtml === 'string' ? nextSectionsHtml.trim() : '';
      const incomingWrappers = Array.from(template.content.querySelectorAll('.group-wrapper'));
      const existingWrappers = Array.from(groupsRoot.querySelectorAll(':scope > .group-wrapper'));
      const existingById = new Map();

      existingWrappers.forEach((wrapper) => {
        if (!(wrapper instanceof HTMLElement)) {
          return;
        }

        const details = wrapper.querySelector('details.group[data-group-id]');
        const groupId = details?.getAttribute('data-group-id');
        if (groupId) {
          existingById.set(groupId, wrapper);
        }
      });

      const seenGroupIds = new Set();
      incomingWrappers.forEach((incomingWrapper) => {
        if (!(incomingWrapper instanceof HTMLElement)) {
          return;
        }

        const incomingDetails = incomingWrapper.querySelector('details.group[data-group-id]');
        const groupId = incomingDetails?.getAttribute('data-group-id');
        if (!groupId) {
          return;
        }

        seenGroupIds.add(groupId);
        const existingWrapper = existingById.get(groupId);
        if (existingWrapper) {
          patchGroupWrapper(existingWrapper, incomingWrapper);
          groupsRoot.appendChild(existingWrapper);
        } else {
          groupsRoot.appendChild(incomingWrapper);
        }
      });

      existingWrappers.forEach((wrapper) => {
        if (!(wrapper instanceof HTMLElement)) {
          return;
        }

        const details = wrapper.querySelector('details.group[data-group-id]');
        const groupId = details?.getAttribute('data-group-id');
        if (groupId && !seenGroupIds.has(groupId)) {
          wrapper.remove();
        }
      });

      return seenGroupIds;
    }

    function applySearchFilter() {
      const normalizedQuery = currentShowSearch ? normalizeSearchQuery(searchQuery) : '';

      document.querySelectorAll('.card[data-id]').forEach((card) => {
        if (!(card instanceof HTMLElement)) {
          return;
        }

        const matches = normalizedQuery.length === 0
          || (card.dataset.search ?? '').includes(normalizedQuery);
        card.hidden = !matches;
      });

      if (normalizedQuery.length === 0) {
        document.querySelectorAll('.group-wrapper').forEach((wrapper) => {
          if (!(wrapper instanceof HTMLElement)) {
            return;
          }

          wrapper.hidden = false;
          wrapper.classList.remove('search-open');
          restoreGroupSummary(wrapper);
        });

        restoreBaseStats();

        const searchMeta = document.getElementById('search-meta');
        if (searchMeta instanceof HTMLElement) {
          searchMeta.textContent = currentCounts.total + ' extension' + (currentCounts.total === 1 ? '' : 's');
        }

        const searchEmpty = document.getElementById('search-empty');
        if (searchEmpty instanceof HTMLElement) {
          searchEmpty.hidden = currentCounts.total > 0;
          searchEmpty.textContent = 'No extensions to show.';
        }

        return;
      }

      const visibleCards = [];
      document.querySelectorAll('.group-wrapper').forEach((wrapper) => {
        if (!(wrapper instanceof HTMLElement)) {
          return;
        }

        const groupVisibleCards = Array.from(wrapper.querySelectorAll('.card[data-id]'))
          .filter((card) => card instanceof HTMLElement && !card.hidden);
        const hasVisibleCards = groupVisibleCards.length > 0;

        wrapper.hidden = !hasVisibleCards;
        wrapper.classList.toggle('search-open', normalizedQuery.length > 0 && hasVisibleCards);
        updateGroupSummary(wrapper, groupVisibleCards);
        visibleCards.push(...groupVisibleCards);
      });

      const visibleExtensionCount = updateVisibleStats(visibleCards);

      const searchMeta = document.getElementById('search-meta');
      if (searchMeta instanceof HTMLElement) {
        searchMeta.textContent = normalizedQuery.length > 0
          ? visibleExtensionCount + ' match' + (visibleExtensionCount === 1 ? '' : 'es')
          : visibleExtensionCount + ' extension' + (visibleExtensionCount === 1 ? '' : 's');
      }

      const searchEmpty = document.getElementById('search-empty');
      if (searchEmpty instanceof HTMLElement) {
        searchEmpty.hidden = visibleExtensionCount > 0;
        searchEmpty.textContent = normalizedQuery.length > 0
          ? 'No extensions match this search.'
          : 'No extensions to show.';
      }
    }

    function setSelectedCard(id) {
      if (selectedCardId === id) {
        return;
      }

      selectedCardId = id;
      applySelectedCard();
      persistViewState();

      vscode.postMessage({
        type: 'setSelectedExtension',
        value: id
      });
    }

    function setOpeningCard(id, opening) {
      const existingTimer = openingCardTimers.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
        openingCardTimers.delete(id);
      }

      if (opening) {
        openingCardIds.add(id);
        const card = document.querySelector('.card[data-id="' + id + '"]');
        if (card instanceof HTMLElement) {
          card.setAttribute('aria-busy', 'true');
        }

        const timer = setTimeout(() => {
          openingCardTimers.delete(id);
          if (!openingCardIds.has(id)) {
            return;
          }

          const nextCard = document.querySelector('.card[data-id="' + id + '"]');
          if (!(nextCard instanceof HTMLElement)) {
            return;
          }

          const badge = nextCard.querySelector('.opening-badge');
          nextCard.classList.add('opening');
          nextCard.setAttribute('aria-busy', 'true');
          if (badge instanceof HTMLElement) {
            badge.hidden = false;
          }
        }, openingIndicatorDelayMs);

        openingCardTimers.set(id, timer);
      } else {
        openingCardIds.delete(id);
        const card = document.querySelector('.card[data-id="' + id + '"]');
        if (card instanceof HTMLElement) {
          const badge = card.querySelector('.opening-badge');
          card.classList.remove('opening');
          card.removeAttribute('aria-busy');
          if (badge instanceof HTMLElement) {
            badge.hidden = true;
          }
        }
      }
    }

    function reapplyOpeningCards() {
      openingCardIds.forEach((id) => {
        const card = document.querySelector('.card[data-id="' + id + '"]');
        if (!(card instanceof HTMLElement)) {
          return;
        }

        const badge = card.querySelector('.opening-badge');
        card.classList.add('opening');
        card.setAttribute('aria-busy', 'true');
        if (badge instanceof HTMLElement) {
          badge.hidden = false;
        }
      });
    }

    function applyRenderPayload(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const previousGroupMode = currentGroupMode;
      const previousShowBuiltin = currentShowBuiltin;
      const payloadExpandedGroupIds = Array.isArray(payload.expandedGroupIds)
        ? payload.expandedGroupIds.filter((value) => typeof value === 'string')
        : [];
      currentGroupMode = payload.groupMode;
      currentShowBuiltin = payload.showBuiltin === true;
      currentShowSearch = payload.showSearch === true;
      currentCounts = payload.counts;
      selectedCardId = typeof payload.selectedExtensionId === 'string'
        ? payload.selectedExtensionId
        : '';
      const shouldTrustPayloadExpandedGroups = currentGroupMode !== previousGroupMode
        || currentShowBuiltin !== previousShowBuiltin;

      if (toolbar instanceof HTMLElement) {
        toolbar.hidden = !currentShowSearch;
      }

      if (!currentShowSearch && searchInput instanceof HTMLInputElement) {
        searchInputFocused = false;
        searchInput.blur();
      }

      if (statsRoot instanceof HTMLElement && typeof payload.statsHtml === 'string') {
        statsRoot.innerHTML = payload.statsHtml;
      }

      let validGroupIds = new Set();
      if (typeof payload.sectionsHtml === 'string') {
        validGroupIds = syncGroupWrappers(payload.sectionsHtml);
      }

      const localExpandedGroupIds = currentExpandedGroupIds.filter((id) => validGroupIds.has(id));
      const nextPayloadExpandedGroupIds = payloadExpandedGroupIds.filter((id) => validGroupIds.has(id));
      if (shouldTrustPayloadExpandedGroups) {
        currentExpandedGroupIds = nextPayloadExpandedGroupIds;
      } else if (localExpandedGroupIds.length > 0 || currentExpandedGroupIds.length > 0) {
        currentExpandedGroupIds = localExpandedGroupIds;
      } else {
        currentExpandedGroupIds = nextPayloadExpandedGroupIds;
      }

      restoreExpandedGroups();
      applySelectedCard();
      bindGroupToggleListeners();
      applySearchFilter();
      reapplyOpeningCards();
      persistViewState();
    }

    function openCard(id) {
      setSelectedCard(id);
      setOpeningCard(id, true);
      vscode.postMessage({
        type: 'openExtension',
        value: id
      });
    }

    restoreExpandedGroups();
    applySelectedCard();
    const searchInput = document.getElementById('extension-search-input');
    if (searchInput instanceof HTMLInputElement) {
      restoreSearchInput(searchInput);
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        applySearchFilter();
        syncSearchInputState(searchInput, true);
      });
      searchInput.addEventListener('focus', () => {
        syncSearchInputState(searchInput, true);
      });
      searchInput.addEventListener('blur', () => {
        syncSearchInputState(searchInput, false);
      });
      searchInput.addEventListener('click', () => {
        syncSearchInputState(searchInput);
      });
      searchInput.addEventListener('keyup', () => {
        syncSearchInputState(searchInput);
      });
      searchInput.addEventListener('select', () => {
        syncSearchInputState(searchInput);
      });
      searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || searchInput.value.length === 0) {
          return;
        }

        event.preventDefault();
        searchInput.value = '';
        searchQuery = '';
        applySearchFilter();
        syncSearchInputState(searchInput, true);
      });
    }

    applySearchFilter();
    persistViewState();
    sendExpandedGroups();

    bindGroupToggleListeners();

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;

      if (message.type === 'replaceViewContent') {
        applyRenderPayload(message.payload);
        return;
      }

      if (message.type === 'setOpeningExtension') {
        if (typeof message.value !== 'string' || typeof message.opening !== 'boolean') {
          return;
        }

        setOpeningCard(message.value, message.opening);

        const groupBtn = document.querySelector('.group-open-btn[data-value="' + message.value + '"]');
        if (groupBtn instanceof HTMLElement) {
          if (message.opening) {
            groupBtn.classList.add('opening');
            groupBtn.textContent = 'Showing\u2026';
          } else {
            groupBtn.classList.remove('opening');
            groupBtn.textContent = 'Show';
          }
        }
      }

      if (message.type === 'resetGroupBtn') {
        const groupBtn = document.querySelector('.group-open-btn[data-value="' + message.value + '"]');
        if (groupBtn instanceof HTMLElement) {
          groupBtn.classList.remove('opening');
          const action = groupBtn.dataset.action;
          groupBtn.textContent = action === 'openExtension' ? 'Show' : 'Search';
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
          target.textContent = action === 'openExtension' ? 'Showing\u2026' : 'Searching\u2026';
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

    vscode.postMessage({ type: 'webviewReady' });
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
