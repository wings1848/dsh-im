#!/usr/bin/env node
/**
 * Documentation delivery gates that the package verifier deliberately leaves open.
 *
 * Two classes of defect shipped repeatedly: README links to `docs/` pages and
 * `docs/images/` pictures that are not in the npm package, and version examples
 * that drift one or two releases behind `package.json`. This script keeps the
 * repository-level invariants cheap to check and free of dependencies:
 *
 * 1. every relative Markdown link/image in the checked documents resolves;
 * 2. README `docs/` and `assets/` references are absolute URLs, because neither
 *    directory ships with the package (only the runtime logo asset does);
 * 3. `@xmanrui/dsh-im@...` examples match the current package version, or use
 *    an explicit placeholder (`<version>`, `latest`, `*`);
 * 4. CHANGELOG carries the current version (or a non-empty Unreleased section);
 * 5. the manifest still ships the bundle, the runtime logo and the metadata the
 *    compatibility gate reads.
 */
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checked = [];
const fail = (message) => { failures.push(message); };

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = packageJson.version;

const markdownLink = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu;

function relativeTargets(text) {
  const targets = [];
  for (const match of text.matchAll(markdownLink)) {
    const target = match[1];
    if (absolute.test(target) || target.startsWith('<')) continue;
    targets.push(target);
  }
  return targets;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function verifyLinks(file) {
  const text = await readFile(join(root, file), 'utf8');
  for (const raw of relativeTargets(text)) {
    const target = raw.split('#', 1)[0];
    if (!target) continue;
    let decoded = target;
    try { decoded = decodeURIComponent(target); } catch { /* keep the literal path */ }
    const absoluteTarget = resolve(dirname(join(root, file)), decoded);
    if (!await exists(absoluteTarget)) fail(`${file}: missing link target ${target}`);
  }
  checked.push(file);
}

async function verifyReadmeDelivery(file) {
  const text = await readFile(join(root, file), 'utf8');
  for (const match of text.matchAll(/(?:src|href)="((?:docs|assets)\/[^"]+)"/gu)) {
    fail(`${file}: relative ${match[0]} must be an absolute URL (the package does not ship that tree)`);
  }
  for (const match of text.matchAll(/\]\(((?:docs|assets)\/[^)#]+)/gu)) {
    fail(`${file}: relative ${match[1]} must be an absolute URL`);
  }
}

const versionExample = /@xmanrui\/dsh-im@([A-Za-z0-9.<>_*-]+)/gu;
async function verifyVersionExamples(file) {
  const text = await readFile(join(root, file), 'utf8');
  for (const match of text.matchAll(versionExample)) {
    const declared = match[1];
    if (declared === '<version>' || declared === 'latest' || declared === '*') continue;
    if (declared !== version) fail(`${file}: example version ${declared} does not match package.json ${version}`);
  }
  checked.push(file);
}

const documents = [
  'README.md',
  'README.en.md',
  'PROACTIVE_DELIVERY.md',
  'PROACTIVE_DELIVERY.en.md',
  'CONTEXT.md',
  'docs/client-integration.md',
  'docs/preset-workspaces.md',
  'docs/检查与安装更新.md',
  'docs/checking-and-installing-updates.md',
];
for (const file of documents) await verifyLinks(file);
for (const file of ['README.md', 'README.en.md']) await verifyReadmeDelivery(file);
for (const file of ['README.md', 'README.en.md', 'PROACTIVE_DELIVERY.md', 'PROACTIVE_DELIVERY.en.md', 'docs/检查与安装更新.md', 'docs/checking-and-installing-updates.md']) {
  await verifyVersionExamples(file);
}

// CHANGELOG must describe the version the manifest ships.
const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${version}]`)) {
  const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/u.exec(changelog)?.[1]?.trim();
  if (!unreleased) fail(`CHANGELOG.md: missing ## [${version}] and Unreleased is empty`);
}
checked.push('CHANGELOG.md');

// Manifest invariants the compatibility gate and the runtime depend on.
const files = Array.isArray(packageJson.files) ? packageJson.files : [];
for (const required of ['lib', 'bin', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!files.some((entry) => entry === required || entry.startsWith(`${required}/`))) {
    fail(`package.json: files is missing ${required}`);
  }
}
if (!files.includes('assets/logo-plugin-message-link-gradient.webp')) {
  fail('package.json: files must ship the runtime logo asset');
}
if (!packageJson.engines?.dsh) fail('package.json: engines.dsh is missing, so the Host compatibility gate is inert');
for (const name of packageJson.dsh?.client?.inject ?? []) {
  if (name === '@deepseek-ai/dsh-client-runtime') {
    fail('package.json: dsh.client.inject still lists the removed @deepseek-ai/dsh-client-runtime');
  }
}

if (failures.length > 0) {
  process.stderr.write(`verify-docs: ${failures.length} problem(s)\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`verify-docs: ${checked.length} documents and the manifest are consistent\n`);
