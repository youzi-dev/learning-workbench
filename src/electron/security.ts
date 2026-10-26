import path from 'node:path';

type ShellFrame = {url: string};
type ShellContents = {mainFrame: ShellFrame};
type IpcSource = {sender: unknown; senderFrame: ShellFrame | null};
type NavigationEvent = {preventDefault(): void; url?: string; isMainFrame?: boolean};
type NavigationListener = (event: NavigationEvent, url?: string, isInPlace?: boolean, isMainFrame?: boolean) => void;
type NavigationContents = {
  on(event: 'will-navigate' | 'will-redirect', listener: NavigationListener): unknown;
  setWindowOpenHandler(handler: () => {action: 'deny'}): void;
};

export type DesktopSecurity = {
  launchUrl: string;
  developmentOrigin: string | null;
  contentSecurityPolicy: string;
  isTrustedShellUrl(url: string): boolean;
  assertTrustedIpc(event: IpcSource, contents: ShellContents | null | undefined): void;
  resolveGrowthAsset(url: string, root: string): string | null;
};

function parsedUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    return url.username || url.password ? null : url;
  } catch { return null; }
}

function isGrowthApp(url: URL): boolean {
  // Custom schemes have a null URL.origin; compare every authority component.
  return url.protocol === 'growth:' && url.hostname === 'app' && url.port === '';
}

export function createDesktopSecurity(options: {isPackaged: boolean; devServerUrl?: string}): DesktopSecurity {
  let developmentUrl: URL | null = null;
  if (!options.isPackaged && options.devServerUrl) {
    developmentUrl = parsedUrl(options.devServerUrl);
    if (!developmentUrl || !['http:', 'https:'].includes(developmentUrl.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(developmentUrl.hostname)) {
      throw new Error('开发页面只能使用本机 loopback HTTP(S) 地址');
    }
  }
  const developmentOrigin = developmentUrl?.origin ?? null;
  const websocketOrigin = developmentUrl ? `${developmentUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${developmentUrl.host}` : null;
  const contentSecurityPolicy = [
    "default-src 'none'",
    `script-src 'self' 'wasm-unsafe-eval'${developmentUrl ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    `connect-src 'self'${websocketOrigin ? ` ${websocketOrigin}` : ''}`,
    "img-src 'self' data: https: blob: growth://files",
    "font-src 'self' data: blob:",
    "media-src 'self' blob: growth://files",
    'frame-src http://127.0.0.1:* http://localhost:*',
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
  const isTrustedShellUrl = (input: string): boolean => {
    const url = parsedUrl(input);
    if (!url) return false;
    if (developmentUrl) return url.protocol === developmentUrl.protocol && url.origin === developmentOrigin;
    return isGrowthApp(url) && (url.pathname === '/' || url.pathname === '/index.html');
  };
  return {
    launchUrl: developmentUrl?.href ?? 'growth://app/index.html',
    developmentOrigin,
    contentSecurityPolicy,
    isTrustedShellUrl,
    assertTrustedIpc(event, contents) {
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || !event.senderFrame || !isTrustedShellUrl(event.senderFrame.url)) {
        throw new Error('只允许可信本机应用主窗口调用');
      }
    },
    resolveGrowthAsset(input, root) {
      const url = parsedUrl(input);
      if (!url || !isGrowthApp(url)) return null;
      let relative: string;
      try { relative = decodeURIComponent(url.pathname.slice(1) || 'index.html'); }
      catch { return null; }
      // Reject Windows separators even when a development check runs on macOS.
      if (relative.includes('\\') || relative.includes('\0')) return null;
      const resolvedRoot = path.resolve(root);
      const file = path.resolve(resolvedRoot, relative);
      return file.startsWith(resolvedRoot + path.sep) ? file : null;
    }
  };
}

export function installShellNavigationGuards(contents: NavigationContents, policy: DesktopSecurity): void {
  const navigation: NavigationListener = (event, url, _isInPlace, isMainFrame) => {
    // Redirects also cover subframes; their local project preview is governed by CSP.
    if ((event.isMainFrame ?? isMainFrame) === false) return;
    if (!policy.isTrustedShellUrl(event.url ?? url ?? '')) event.preventDefault();
  };
  contents.on('will-navigate', navigation);
  contents.on('will-redirect', navigation);
  // External links require the existing explicit tutorial action or reader confirmation.
  contents.setWindowOpenHandler(() => ({action: 'deny'}));
}
