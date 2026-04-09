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
      { webviewOptions: { retainContextWhenHidden: true } }
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  public refresh(): void {
    if (this.view) void this.render(this.view);
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'manage':
          await vscode.commands.executeCommand('workbench.view.extensions');
          await vscode.commands.executeCommand('workbench.extensions.search', msg.value);
          break;
        case 'refresh':
          await this.render(view);
          break;
      }
    });

    await this.render(view);
  }

  private async render(view: vscode.WebviewView) {
    const items = vscode.extensions.all.map((ext) => {
      const pkg = ext.packageJSON as any;

      return {
        id: ext.id,
        publisher: ext.id.split('.')[0],
        name: pkg.displayName || ext.id,
        version: pkg.version || '',
        description: pkg.description || '',
        iconUri: pkg.icon
          ? view.webview.asWebviewUri(
              vscode.Uri.joinPath(vscode.Uri.file(ext.extensionPath), pkg.icon)
            )
          : undefined,
        isBuiltin: pkg.isBuiltin === true,
        isActive: ext.isActive === true,
      };
    });

    const counts = this.getCounts(items);

    view.webview.html = this.getHtml(view.webview, items, counts);
  }

  private getCounts(items: ExtensionItem[]): SummaryCounts {
    const installed = items.filter(i => !i.isBuiltin);
    const builtin = items.filter(i => i.isBuiltin);

    return {
      total: items.length,
      active: items.filter(i => i.isActive).length,
      inactive: items.filter(i => !i.isActive).length,
      installed: installed.length,
      installedActive: installed.filter(i => i.isActive).length,
      installedInactive: installed.filter(i => !i.isActive).length,
      builtin: builtin.length,
      builtinActive: builtin.filter(i => i.isActive).length,
      builtinInactive: builtin.filter(i => !i.isActive).length,
    };
  }

  private getHtml(webview: vscode.Webview, items: ExtensionItem[], counts: SummaryCounts): string {
    const cards = items.map(item => {
      const status = item.isActive ? 'Active' : 'Idle';
      const kind = item.isBuiltin ? 'Built-in' : '';

      return `
        <div class="card">
          <div class="title">
            <b>${item.name}</b>
            ${kind ? `<span class="badge">${kind}</span>` : ''}
            <span class="badge ${item.isActive ? 'active' : ''}">${status}</span>
          </div>
          <div class="desc">${item.description}</div>
          <button onclick="manage('${item.id}')">Manage</button>
        </div>
      `;
    }).join('');

    return `
      <html>
      <body>
        <h3>Total ${counts.total} (Active ${counts.active} · Idle ${counts.inactive})</h3>
        ${cards}
        <script>
          const vscode = acquireVsCodeApi();
          function manage(id) {
            vscode.postMessage({ type: 'manage', value: id });
          }
        </script>
      </body>
      </html>
    `;
  }
}
