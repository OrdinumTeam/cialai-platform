// SPDX-License-Identifier: Apache-2.0
// Cria, confere, soma e publica a release do GitHub pelo gh, sem expor tokens.
// Uso:
//   node tools/release/release-assets.mjs draft <tag> <preview|stable>
//   node tools/release/release-assets.mjs verify <tag>
//   node tools/release/release-assets.mjs checksums <tag>
//   node tools/release/release-assets.mjs publish <tag>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHECKSUM_FILE = 'SHA256SUMS';

// Um padrão por instalador e por arquivo do atualizador que toda release do desktop precisa ter.
export const REQUIRED_ASSETS = [
  ['macOS Apple silicon DMG', /aarch64.*\.dmg$/],
  ['macOS Intel DMG', /(x64|x86_64).*\.dmg$/],
  ['macOS Apple silicon updater', /aarch64.*\.app\.tar\.gz$/],
  ['macOS Apple silicon updater signature', /aarch64.*\.app\.tar\.gz\.sig$/],
  ['macOS Intel updater', /(x64|x86_64).*\.app\.tar\.gz$/],
  ['macOS Intel updater signature', /(x64|x86_64).*\.app\.tar\.gz\.sig$/],
  ['Windows setup', /-setup\.exe$/],
  ['Windows setup signature', /-setup\.exe\.sig$/],
  ['Windows MSI', /\.msi$/],
  ['Linux AppImage', /\.AppImage$/],
  ['Linux AppImage signature', /\.AppImage\.sig$/],
  ['Linux DEB', /\.deb$/],
  ['Linux RPM', /\.rpm$/],
  ['Updater manifest', /^latest\.json$/],
];

export function missingAssets(names) {
  return REQUIRED_ASSETS.filter(([, pattern]) => !names.some((name) => pattern.test(name))).map(([label]) => label);
}

export function formatChecksums(entries) {
  return [...entries]
    .filter(({ name }) => name !== CHECKSUM_FILE)
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map(({ name, sha256 }) => {
      if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid SHA 256 for ${name}`);
      if (/[\r\n]/.test(name)) throw new Error('Asset names cannot contain line breaks');
      return `${sha256}  ${name}\n`;
    })
    .join('');
}

export function releaseNotes(template, tag) {
  if (!/^v\d+\.\d+\.\d+/.test(tag)) throw new Error(`Invalid tag ${tag}`);
  return template.replaceAll('{{version}}', tag.slice(1)).replaceAll('{{tag}}', tag);
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

function repository() {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Set GH_REPO or GITHUB_REPOSITORY to owner/name');
  return repo;
}

// A API de tags não devolve rascunhos, então a busca percorre a lista de releases.
function findRelease(tag) {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository()}/releases?per_page=100`]));
  return pages.flat().find((release) => release.tag_name === tag);
}

function requireRelease(tag) {
  const release = findRelease(tag);
  if (!release) throw new Error(`No release found for ${tag}`);
  return release;
}

function draft(tag, channel) {
  if (!['preview', 'stable'].includes(channel)) throw new Error(`Unknown channel ${channel}`);
  const existing = findRelease(tag);
  if (existing) {
    console.log(`release_id=${existing.id}`);
    return;
  }
  const root = new URL('../../', import.meta.url);
  const template = readFileSync(new URL(`tools/release/notes/${channel}.md`, root), 'utf8');
  const body = releaseNotes(template, tag);
  const created = JSON.parse(gh([
    'api', '--method', 'POST', `repos/${repository()}/releases`,
    '-f', `tag_name=${tag}`,
    '-f', `name=Cialai ${tag}`,
    '-F', 'draft=true',
    '-F', 'prerelease=false',
    '-F', 'body=@-',
  ], { input: body, stdio: ['pipe', 'pipe', 'inherit'] }));
  console.log(`release_id=${created.id}`);
}

function verify(tag) {
  const names = requireRelease(tag).assets.map((asset) => asset.name);
  const missing = missingAssets(names);
  if (missing.length) throw new Error(`Release ${tag} is missing: ${missing.join(', ')}`);
  console.log(`PASS ${names.length} assets present in ${tag}`);
}

function checksums(tag) {
  const release = requireRelease(tag);
  const directory = mkdtempSync(join(tmpdir(), 'cialai-release-'));
  try {
    const names = release.assets.map((asset) => asset.name).filter((name) => name !== CHECKSUM_FILE);
    for (const name of names) {
      gh(['release', 'download', tag, '--repo', repository(), '--pattern', name, '--dir', directory, '--clobber']);
    }
    const entries = readdirSync(directory).map((name) => ({
      name,
      sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'),
    }));
    if (entries.length !== names.length) throw new Error('Downloaded assets do not match the release list');
    const output = join(directory, CHECKSUM_FILE);
    writeFileSync(output, formatChecksums(entries));
    gh(['release', 'upload', tag, output, '--repo', repository(), '--clobber']);
    console.log(`PASS ${CHECKSUM_FILE} covers ${entries.length} assets of ${tag}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function publish(tag) {
  requireRelease(tag);
  gh(['release', 'edit', tag, '--repo', repository(), '--draft=false', '--prerelease=false', '--latest']);
  console.log(`PASS ${tag} published as the latest release`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, tag, channel] = process.argv.slice(2);
  const commands = { draft: () => draft(tag, channel), verify: () => verify(tag), checksums: () => checksums(tag), publish: () => publish(tag) };
  if (!commands[command] || !tag) {
    console.error('Usage: release-assets.mjs draft|verify|checksums|publish <tag> [channel]');
    process.exit(64);
  }
  commands[command]();
}
