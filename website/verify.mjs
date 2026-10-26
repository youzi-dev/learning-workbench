import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { siteConfig } from './config.js';
import { resolveProjectLinks } from './app.js';

const root = new URL('./', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const css = await readFile(new URL('styles.css', root), 'utf8');
assert.match(html, /^<!doctype html>/i, 'HTML5 document required');
assert.match(html, /<html lang="zh-CN">/, 'Chinese document language required');
assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
assert.equal((html.match(/<h1\b/g) ?? []).length, 1, 'Exactly one main heading required');
assert.match(html, /<main id="main">/);
assert.match(html, /class="skip-link" href="#main"/);
assert.match(css, /:focus-visible/);
assert.match(css, /prefers-reduced-motion/);
assert(!/<(?:script|link|img|iframe|video|audio)\b[^>]*(?:src|href)="https?:/i.test(html), 'External assets are not permitted');
assert(!/<form\b/i.test(html), 'This site does not collect form data');

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
let checkedLinks = 0;
for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  const value = match[1];
  if (value.startsWith('#')) {
    assert(ids.includes(value.slice(1)), `Missing anchor ${value}`);
  } else {
    const url = new URL(value, new URL('index.html', root));
    if (url.protocol === 'file:') {
      assert(fileURLToPath(url).startsWith(fileURLToPath(root)), `Relative link leaves published directory: ${value}`);
      const file = await stat(url);
      assert(file.isFile(), `Relative link is not a file: ${value}`);
    } else {
      assert.equal(url.protocol, 'https:', `Unsupported link protocol: ${value}`);
    }
  }
  checkedLinks += 1;
}

const defaults = resolveProjectLinks({});
for (const key of ['source', 'builds', 'docs', 'license', 'notices']) assert.equal(defaults[key], '#project-status');
assert.equal(defaults.release, '#platforms', 'Unconfigured releases must not imply an available download');
const sample = resolveProjectLinks({ repositoryUrl: 'https://github.com/example/workbench/' });
assert.equal(sample.source, 'https://github.com/example/workbench');
assert.equal(sample.builds, '#project-status', 'A repository alone does not imply available CI');
assert.equal(sample.docs, 'https://github.com/example/workbench/#readme');
assert.equal(sample.release, '#platforms', 'A public repository alone does not enable a download');
assert.throws(() => resolveProjectLinks({ repositoryUrl: 'javascript:alert(1)' }));
assert.throws(() => resolveProjectLinks({ releaseUrl: 'https://user:secret@example.com/' }));
const current = resolveProjectLinks(siteConfig);
for (const match of html.matchAll(/data-project-link="([^"]+)"/g)) assert(match[1] in current, `Unknown project link: ${match[1]}`);

console.log(`Website checks passed: ${ids.length} unique IDs, ${checkedLinks} local links/assets, public link configuration and unavailable-release behavior.`);
