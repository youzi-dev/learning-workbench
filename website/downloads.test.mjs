import assert from 'node:assert/strict';
import {test} from 'node:test';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import * as site from './app.js';
import {siteConfig} from './config.js';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const version = '0.11.1';
const unpublished = {...siteConfig, downloads: {}};
const asset = name => `https://github.com/example/workbench/releases/download/v${version}/${name}`;
const configured = {
  ...siteConfig, version,
  downloads: {
    android: asset(`learning-workbench-android-private-${version}.apk`),
    windowsX64: asset(`learning-workbench-win-x64-unsigned-development-${version}-setup.exe`),
    macArm64: asset(`learning-workbench-mac-arm64-private-${version}.zip`),
    macX64: null,
  },
};

test('OS recommendation distinguishes Android, Windows, Mac, iOS and unknown without inferring Mac architecture', () => {
  const cases = [
    [{userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36'}, 'android'],
    [{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}, 'windows'],
    [{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform:'MacIntel', maxTouchPoints:0}, 'mac'],
    [{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform:'MacIntel', maxTouchPoints:5}, 'ios'],
    [{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'}, 'ios'],
    [{userAgent:'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'}, 'ios'],
    [{userAgent:'Mozilla/5.0 (X11; Linux x86_64)'}, 'unknown'],
    [{}, 'unknown'],
  ];
  for (const [input, expected] of cases) assert.equal(site.detectPlatform(input), expected);
});

test('unpublished packages produce no download href, while published links retain exact architecture', () => {
  const document = new JSDOM(html).window.document;
  site.applyDownloads(document, unpublished, {userAgent:'Linux Android 14'});
  for (const link of document.querySelectorAll('[data-download]')) {
    assert.equal(link.hasAttribute('href'), false);
    assert.equal(link.getAttribute('aria-disabled'), 'true');
    assert.match(link.textContent, /准备中/);
  }
  assert.equal(document.querySelector('[data-platform="android"]').classList.contains('is-recommended'), true);
  site.applyDownloads(document, configured, {userAgent:'Macintosh', platform:'MacIntel', maxTouchPoints:0});
  assert.equal(document.querySelector('[data-download="macArm64"]').href, configured.downloads.macArm64);
  assert.equal(document.querySelector('[data-download="macX64"]').hasAttribute('href'), false);
  assert.match(document.querySelector('[data-platform-hint]').textContent, /芯片|架构/);
  assert.equal(document.querySelectorAll('[data-download][href]').length, 3);
  site.applyDownloads(document, unpublished, {userAgent:'iPhone'});
  assert.equal(document.querySelectorAll('[data-download][href]').length, 0, 'Removing configuration must remove stale URLs');
  assert.match(document.querySelector('[data-platform-hint]').textContent, /iOS|iPhone/);
  assert.equal(document.querySelectorAll('.is-recommended').length, 0);
});

test('download validation rejects wrong extension, architecture, version, credential URL and non-HTTPS', () => {
  const valid = site.resolveDownloads(configured);
  assert.equal(valid.android, configured.downloads.android);
  assert.equal(valid.macX64, null);
  for (const url of [
    asset(`learning-workbench-mac-arm64-private-${version}.zip`),
    asset('learning-workbench-android-private-0.10.0.apk'),
    `http://example.com/learning-workbench-android-private-${version}.apk`,
    `https://user:secret@example.com/learning-workbench-android-private-${version}.apk`,
  ]) assert.throws(() => site.resolveDownloads({...configured, downloads:{...configured.downloads, android:url}}));
  assert.throws(() => site.resolveDownloads({...configured, downloads:{...configured.downloads, macArm64:asset(`learning-workbench-mac-x64-private-${version}.zip`)}}));
  assert.deepEqual(Object.values(site.resolveDownloads({version, downloads:{}})), [null,null,null,null]);
});

test('project links do not invent workflow or browser deployments', () => {
  const links = site.resolveProjectLinks(siteConfig);
  assert.equal(links.source, 'https://github.com/youzi-dev/learning-workbench');
  assert.equal(links.builds, '#project-status');
  assert.equal(links.browser, '#platforms');
});
