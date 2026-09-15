// SPDX-License-Identifier: Apache-2.0
// Cria, confere, soma e publica a release do GitHub pelo gh, sem expor tokens.
// Uso:
//   node tools/release/release-assets.mjs draft <tag> <preview|stable>
//   node tools/release/release-assets.mjs upload-linux <tag> <pasta bundle do Tauri>
//   node tools/release/release-assets.mjs updater-json <tag>
//   node tools/release/release-assets.mjs verify <tag>
//   node tools/release/release-assets.mjs checksums <tag>
//   node tools/release/release-assets.mjs publish <tag>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

// Os pacotes Linux sobem pelo gh depois da correção do AppImage, com os nomes que o tauri-action gerava com
// "[name]_[arch][setup][ext]": Cialai_0.2.0_amd64.AppImage vira Cialai_amd64.AppImage e
// Cialai-0.2.0-1.x86_64.rpm vira Cialai_x86_64.rpm, com as assinaturas .sig acompanhando.
export function stableLinuxName(fileName) {
  const debian = fileName.match(/^([^_]+)_[^_]+_([^_.]+)(\.AppImage|\.deb)(\.sig)?$/);
  if (debian) return `${debian[1]}_${debian[2]}${debian[3]}${debian[4] ?? ''}`;
  const rpm = fileName.match(/^(.+)-[^-]+-\d+\.([^.]+)\.rpm(\.sig)?$/);
  if (rpm) return `${rpm[1]}_${rpm[2]}.rpm${rpm[3] ?? ''}`;
  return null;
}

export function linuxReleaseAssets(files) {
  const assets = files
    .map((source) => ({ source, name: stableLinuxName(basename(source)) }))
    .filter(({ name }) => name)
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  const names = assets.map(({ name }) => name);
  if (new Set(names).size !== names.length) throw new Error(`Duplicate Linux bundles: ${names.join(', ')}`);
  const missing = missingAssets(names).filter((label) => label.startsWith('Linux '));
  if (missing.length) throw new Error(`Linux bundle is missing: ${missing.join(', ')}`);
  return assets;
}

// O latest.json é montado uma vez, depois da matriz, para que jobs paralelos não sobrescrevam as
// entradas uns dos outros. Cada chave aponta para o pacote do atualizador e a assinatura minisign dele.
export const UPDATER_PLATFORMS = [
  { keys: ['darwin-aarch64', 'darwin-aarch64-app'], bundle: /aarch64.*\.app\.tar\.gz$/, required: true },
  { keys: ['darwin-x86_64', 'darwin-x86_64-app'], bundle: /(x64|x86_64).*\.app\.tar\.gz$/, required: true },
  { keys: ['linux-x86_64', 'linux-x86_64-appimage'], bundle: /\.AppImage$/, required: true },
  { keys: ['linux-x86_64-deb'], bundle: /\.deb$/, required: false },
  { keys: ['linux-x86_64-rpm'], bundle: /\.rpm$/, required: false },
  { keys: ['windows-x86_64', 'windows-x86_64-nsis'], bundle: /-setup\.exe$/, required: true },
  { keys: ['windows-x86_64-msi'], bundle: /\.msi$/, required: false },
];

export function updaterManifest({ tag, repo, names, signatures, notes, date }) {
  const platforms = {};
  for (const { keys, bundle, required } of UPDATER_PLATFORMS) {
    const name = names.find((candidate) => bundle.test(candidate));
    const signature = name ? signatures[`${name}.sig`]?.trim() : undefined;
    if (!name || !signature) {
      if (required) throw new Error(`Updater bundle or signature missing for ${keys[0]}`);
      continue;
    }
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    for (const key of keys) platforms[key] = { signature, url };
  }
  return { version: tag.replace(/^v/, ''), notes, pub_date: date.toISOString().replace(/\.\d{3}Z$/, 'Z'), platforms };
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

function uploadLinux(tag, bundle) {
  if (!bundle) throw new Error('Pass the Tauri bundle directory');
  requireRelease(tag);
  const files = ['appimage', 'deb', 'rpm'].flatMap((kind) => readdirSync(join(bundle, kind)).map((name) => join(bundle, kind, name)));
  const assets = linuxReleaseAssets(files);
  const directory = mkdtempSync(join(tmpdir(), 'cialai-linux-'));
  try {
    const paths = assets.map(({ source, name }) => {
      copyFileSync(source, join(directory, name));
      return join(directory, name);
    });
    gh(['release', 'upload', tag, ...paths, '--repo', repository(), '--clobber']);
    console.log(`PASS ${assets.length} Linux assets uploaded to ${tag}: ${assets.map(({ name }) => name).join(', ')}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function updaterJson(tag) {
  const release = requireRelease(tag);
  const names = release.assets.map((asset) => asset.name);
  const directory = mkdtempSync(join(tmpdir(), 'cialai-updater-'));
  try {
    const signatures = {};
    for (const name of names.filter((candidate) => candidate.endsWith('.sig'))) {
      gh(['release', 'download', tag, '--repo', repository(), '--pattern', name, '--dir', directory, '--clobber']);
      signatures[name] = readFileSync(join(directory, name), 'utf8');
    }
    const manifest = updaterManifest({
      tag,
      repo: repository(),
      names: names.filter((name) => !name.endsWith('.sig')),
      signatures,
      notes: `Cialai ${tag}. See https://github.com/${repository()}/releases/tag/${tag}`,
      date: new Date(),
    });
    const output = join(directory, 'latest.json');
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    gh(['release', 'upload', tag, output, '--repo', repository(), '--clobber']);
    console.log(`PASS latest.json lists ${Object.keys(manifest.platforms).length} updater targets for ${tag}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  const commands = {
    draft: () => draft(tag, channel),
    'upload-linux': () => uploadLinux(tag, channel),
    'updater-json': () => updaterJson(tag),
    verify: () => verify(tag),
    checksums: () => checksums(tag),
    publish: () => publish(tag),
  };
  if (!commands[command] || !tag) {
    console.error('Usage: release-assets.mjs draft|upload-linux|updater-json|verify|checksums|publish <tag> [channel|bundle]');
    process.exit(64);
  }
  commands[command]();
}
