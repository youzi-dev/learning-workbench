import { siteConfig } from './config.js';

function publicUrl(value, name) {
  if (value === null || value === undefined || value === '') return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${name} must be a public HTTPS URL without credentials`);
  }
  return url.href.replace(/\/$/, '');
}

export function resolveProjectLinks(config) {
  const repository = publicUrl(config.repositoryUrl, 'repositoryUrl');
  const status = '#project-status';
  return {
    source: repository ?? status,
    builds: publicUrl(config.buildsUrl, 'buildsUrl') ?? status,
    docs: publicUrl(config.documentationUrl, 'documentationUrl') ?? (repository ? `${repository}/#readme` : status),
    license: publicUrl(config.licenseUrl, 'licenseUrl') ?? (repository ? `${repository}/blob/main/LICENSE` : status),
    notices: publicUrl(config.noticesUrl, 'noticesUrl') ?? (repository ? `${repository}/blob/main/THIRD_PARTY_NOTICES.md` : status),
    release: publicUrl(config.releaseUrl, 'releaseUrl') ?? '#platforms',
    browser: publicUrl(config.browserUrl, 'browserUrl') ?? '#platforms',
  };
}

/** Detection recommends a card only. Mac user agents do not reveal the chip reliably. */
export function detectPlatform({userAgent = '', platform = '', maxTouchPoints = 0} = {}) {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Mac/i.test(userAgent + platform) && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/Windows/i.test(userAgent) || /^Win/i.test(platform)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(userAgent) || /^Mac/i.test(platform)) return 'mac';
  return 'unknown';
}

export function resolveDownloads(config) {
  if (!/^\d+\.\d+\.\d+$/.test(config.version ?? '')) throw new Error('A plain release version is required');
  const version = config.version;
  const names = {
    android: `learning-workbench-android-private-${version}.apk`,
    windowsX64: `learning-workbench-win-x64-unsigned-development-${version}-setup.exe`,
    macArm64: `learning-workbench-mac-arm64-private-${version}.zip`,
    macX64: `learning-workbench-mac-x64-private-${version}.zip`,
  };
  return Object.fromEntries(Object.entries(names).map(([key, filename]) => {
    const value = publicUrl(config.downloads?.[key], `downloads.${key}`);
    if (value) {
      const url = new URL(value);
      if (decodeURIComponent(url.pathname.split('/').at(-1)) !== filename || url.hash) {
        throw new Error(`downloads.${key} must match its platform, architecture and version`);
      }
    }
    return [key, value];
  }));
}

export function applyDownloads(document, config, device = {}) {
  const downloads = resolveDownloads(config);
  const platform = detectPlatform(device);
  const hints = {
    android: '已识别为 Android，可选择 Android 安装包；其他平台仍可手动选择。',
    windows: '已识别为 Windows，请选择 x64 安装包。其他平台仍可手动选择。',
    mac: '已识别为 Mac。请在「关于本机」查看芯片，再选择 Apple Silicon 或 Intel 架构。',
    ios: 'iPhone / iPad（iOS）不在首发范围内。可在 Android、Windows 或 Mac 使用日常工作台。',
    unknown: '请选择设备平台；Mac 请先在「关于本机」确认芯片类型。',
  };
  const hint = document.querySelector('[data-platform-hint]');
  if (hint) hint.textContent = hints[platform];
  for (const card of document.querySelectorAll('[data-platform]')) {
    const recommended = card.dataset.platform === platform;
    card.classList.toggle('is-recommended', recommended);
    const label = card.querySelector('[data-recommendation]');
    if (label) label.hidden = !recommended;
  }
  for (const anchor of document.querySelectorAll('[data-download]')) {
    const key = anchor.dataset.download;
    const url = downloads[key];
    const label = anchor.dataset.downloadLabel;
    if (url) {
      anchor.setAttribute('href', url);
      anchor.removeAttribute('aria-disabled');
      anchor.textContent = `下载 ${label}`;
    } else {
      anchor.removeAttribute('href');
      anchor.setAttribute('aria-disabled', 'true');
      anchor.textContent = `${label} · 准备中`;
    }
  }
}

export function applyProjectLinks(document, config) {
  const links = resolveProjectLinks(config);
  for (const anchor of document.querySelectorAll('[data-project-link]')) {
    const href = links[anchor.dataset.projectLink];
    if (!href) continue;
    anchor.setAttribute('href', href);
    if (href.startsWith('https:')) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      anchor.setAttribute('aria-label', `${anchor.textContent.trim()}（新标签页）`);
    }
  }
}

if (typeof document !== 'undefined') {
  applyProjectLinks(document, siteConfig);
  applyDownloads(document, siteConfig, globalThis.navigator ?? {});
}
