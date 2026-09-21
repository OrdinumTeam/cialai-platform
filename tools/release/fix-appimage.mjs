// SPDX-License-Identifier: Apache-2.0
// Pós-processa o AppImage que o Tauri gera com o linuxdeploy no Ubuntu 22.04 para que ele abra em
// distribuições novas, como Arch com Mesa 26 e Ubuntu recente. Roda antes de qualquer assinatura.
//
//   1. Extrai o AppImage.
//   2. Remove do bundle as bibliotecas que a pilha gráfica do sistema também carrega. O libEGL, o
//      libgallium e os drivers DRI vêm sempre do sistema; se as dependências deles forem resolvidas
//      pelas cópias antigas do bundle, o Mesa não inicializa e o WebKit aborta com EGL_BAD_ALLOC ou
//      EGL_BAD_PARAMETER.
//   3. Aponta o RUNPATH de todo ELF do bundle para usr/lib. O WebKitWebProcess e o WebKitNetworkProcess
//      saem com RUNPATH=$ORIGIN numa pasta sem bibliotecas e, sem LD_LIBRARY_PATH, carregariam o
//      WebKitGTK do sistema.
//   4. Troca o AppRun do linuxdeploy por tools/release/appimage/AppRun, que não exporta PATH,
//      LD_LIBRARY_PATH, PYTHON*, PERLLIB nem QT_PLUGIN_PATH e isola os módulos GIO do bundle.
//   5. Reempacota com o appimagetool e o runtime fixados por versão e SHA-256.
//
// Uso: node tools/release/fix-appimage.mjs <AppImage> [--output <arquivo>]
// Precisa de patchelf e file no PATH e de um Linux x86_64 que execute o AppImage.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APPIMAGETOOL = Object.freeze({
  version: '1.9.1',
  url: 'https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage',
  sha256: 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0',
});

// Runtime estático do type2-runtime: abre sem libfuse2 no sistema.
export const APPIMAGE_RUNTIME = Object.freeze({
  version: '20251108',
  url: 'https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64',
  sha256: '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d',
});

// Bibliotecas que ficam com o sistema. O excludelist do linuxdeploy já deixa de fora glibc, libGL, libEGL,
// libdrm, libgbm, libX11, libxcb, libz, libexpat, libstdc++, libgcc_s, fontconfig, freetype e harfbuzz; esta
// lista cobre o que ele ainda copia e repete as famílias inteiras para não depender da versão do linuxdeploy.
// Tudo aqui existe em qualquer desktop com glibc 2.35 ou mais nova, o piso do build no Ubuntu 22.04.
// WebKitGTK, JavaScriptCore, libsoup, ICU, GTK, GLib, GStreamer e libxml2 continuam no bundle: não existem
// em todas as distribuições nas versões do build, e o Arch já trocou o soname do libxml2.
export const HOST_LIBRARIES = Object.freeze([
  { pattern: /^lib(EGL|GL|GLX|GLdispatch|GLES\w*|OpenGL|glapi|gbm|gallium|vulkan|LLVM|xshmfence)([-_.].*)?\.so/, reason: 'pilha gráfica do Mesa e do libglvnd' },
  { pattern: /^libdrm(_\w+)?\.so/, reason: 'pilha gráfica do Mesa' },
  { pattern: /^libwayland-(client|cursor|egl|server)\.so/, reason: 'Wayland, carregado pelo libEGL_mesa e pelo libgbm' },
  { pattern: /^libxcb(-[\w-]+)?\.so/, reason: 'família XCB, que precisa acompanhar o libxcb do sistema' },
  { pattern: /^libX(11(-xcb)?|au|dmcp|ext|fixes|xf86vm)\.so/, reason: 'bibliotecas X11 carregadas pelo Mesa' },
  { pattern: /^lib(expat|z|zstd|ffi|elf|stdc\+\+|gcc_s)\.so/, reason: 'dependências de base do Mesa e dos drivers DRI' },
]);

export function hostLibraryReason(name) {
  return HOST_LIBRARIES.find(({ pattern }) => pattern.test(name))?.reason ?? null;
}

// Recursos do Tauri, com o Tor e as bibliotecas dele, trazem o próprio RUNPATH e ficam como estão.
export const RESOURCE_DIR = 'usr/lib/Cialai/';

function posixPath(path) {
  return path.split(sep).join(posix.sep);
}

export function bundleRunpath(path) {
  const file = posixPath(path);
  if (!file.startsWith('usr/') || file.startsWith(RESOURCE_DIR)) return null;
  const up = posix.relative(posix.dirname(file), 'usr/lib');
  return up ? `$ORIGIN/${up}` : '$ORIGIN';
}

// Caminhos que o AppRun próprio usa. Cada item é uma lista de alternativas,
// porque o linuxdeploy ora grava os módulos do GTK, do gdk-pixbuf e do GIO em
// `usr/lib/x86_64-linux-gnu`, ora direto em `usr/lib`, sem o diretório da
// arquitetura. O WebKit, até aqui, ficou sempre no primeiro. Exigir um layout
// só derrubava a release quando o bundler mudava de ideia, que foi o que
// aconteceu entre a 0.2.6 e a 0.2.7. Se nenhuma alternativa existir, a
// correção para: aí o layout mudou de verdade.
const ARCH_LIB = 'usr/lib/x86_64-linux-gnu';
const PLAIN_LIB = 'usr/lib';
const nosDoisLugares = (resto) => [`${ARCH_LIB}/${resto}`, `${PLAIN_LIB}/${resto}`];

export const APPRUN_PATHS = Object.freeze([
  ['usr/bin/cialai-desktop'],
  nosDoisLugares('webkit2gtk-4.1/WebKitWebProcess'),
  nosDoisLugares('webkit2gtk-4.1/WebKitNetworkProcess'),
  nosDoisLugares('gtk-3.0/3.0.0/immodules.cache'),
  nosDoisLugares('gdk-pixbuf-2.0/2.10.0/loaders.cache'),
  nosDoisLugares('gio/modules/libgiognutls.so'),
  ['usr/share/glib-2.0/schemas'],
].map(Object.freeze));

export const APPRUN_TEMPLATE = fileURLToPath(new URL('./appimage/AppRun', import.meta.url));

// As ferramentas não herdam o LD_LIBRARY_PATH que o build usa para o Tor.
function toolEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.LD_LIBRARY_PATH;
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: toolEnv(), ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function pinnedTool(spec, name) {
  const cache = process.env.CIALAI_APPIMAGE_TOOLS || join(homedir(), '.cache', 'cialai-appimage');
  const path = join(cache, `${spec.version}-${name}`);
  if (!existsSync(path) || await sha256(path) !== spec.sha256) {
    mkdirSync(cache, { recursive: true });
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`Download of ${spec.url} failed with HTTP ${response.status}`);
    const partial = `${path}.partial`;
    writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    const actual = await sha256(partial);
    if (actual !== spec.sha256) {
      rmSync(partial, { force: true });
      throw new Error(`${spec.url} has SHA-256 ${actual}, expected ${spec.sha256}`);
    }
    renameSync(partial, path);
  }
  chmodSync(path, 0o755);
  return path;
}

function isElf(path) {
  const fd = openSync(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    return readSync(fd, magic, 0, 4, 0) === 4 && magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    closeSync(fd);
  }
}

// Arquivos e links, sem entrar em diretórios por link.
function* bundleFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* bundleFiles(path);
    else yield path;
  }
}

function removeHostLibraries(appDir) {
  const removed = [];
  for (const path of bundleFiles(join(appDir, 'usr', 'lib'))) {
    const file = posixPath(relative(appDir, path));
    const reason = hostLibraryReason(basename(path));
    if (!reason || file.startsWith(RESOURCE_DIR)) continue;
    rmSync(path);
    removed.push({ file, reason });
  }
  return removed;
}

function fixRunpaths(appDir) {
  const changed = [];
  for (const path of bundleFiles(appDir)) {
    if (!lstatSync(path).isFile()) continue;
    const wanted = bundleRunpath(relative(appDir, path));
    if (!wanted || !isElf(path)) continue;
    // Binários estáticos, como o sidecar em Go, não têm seção dinâmica e ficam como estão.
    const current = spawnSync('patchelf', ['--print-rpath', path], { encoding: 'utf8', env: toolEnv() });
    if (current.error) throw current.error;
    if (current.status !== 0) continue;
    if (current.stdout.trim() === wanted) continue;
    const mode = statSync(path).mode;
    chmodSync(path, mode | 0o200);
    run('patchelf', ['--set-rpath', wanted, path]);
    chmodSync(path, mode);
    changed.push({ path: relative(appDir, path), from: current.stdout.trim(), to: wanted });
  }
  return changed;
}

function replaceAppRun(appDir) {
  for (const alternativas of APPRUN_PATHS) {
    if (alternativas.some((path) => existsSync(join(appDir, path)))) continue;
    throw new Error(`The AppImage layout changed: none of ${alternativas.join(' or ')} is present`);
  }
  rmSync(join(appDir, 'AppRun.wrapped'), { force: true });
  rmSync(join(appDir, 'apprun-hooks'), { recursive: true, force: true });
  rmSync(join(appDir, 'AppRun'), { force: true });
  copyFileSync(APPRUN_TEMPLATE, join(appDir, 'AppRun'));
  chmodSync(join(appDir, 'AppRun'), 0o755);
}

export async function fixAppImage(input, output = input) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('fix-appimage runs on Linux x86_64');
  const source = resolve(input);
  const target = resolve(output);
  const work = mkdtempSync(join(tmpdir(), 'cialai-appimage-'));
  try {
    const [appimagetool, runtime] = await Promise.all([
      pinnedTool(APPIMAGETOOL, 'appimagetool-x86_64.AppImage'),
      pinnedTool(APPIMAGE_RUNTIME, 'runtime-x86_64'),
    ]);
    chmodSync(source, statSync(source).mode | 0o111);
    run(source, ['--appimage-extract'], { cwd: work, stdio: ['ignore', 'ignore', 'pipe'] });
    const appDir = join(work, 'squashfs-root');

    const removed = removeHostLibraries(appDir);
    for (const { file, reason } of removed) console.log(`removed ${file}: ${reason}`);
    const runpaths = fixRunpaths(appDir);
    for (const { path, from, to } of runpaths) console.log(`runpath ${path}: ${from || 'none'} -> ${to}`);
    replaceAppRun(appDir);

    const packed = join(work, basename(target));
    run(appimagetool, ['--no-appstream', '--runtime-file', runtime, appDir, packed], {
      cwd: work,
      env: toolEnv({ ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' }),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(packed, `${target}.partial`);
    chmodSync(`${target}.partial`, 0o755);
    renameSync(`${target}.partial`, target);
    console.log(`PASS ${basename(target)}: ${removed.length} host libraries removed, ${runpaths.length} runpaths fixed, AppRun replaced, sha256 ${await sha256(target)}`);
    return { removed, runpaths };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const output = outputIndex === -1 ? undefined : args.splice(outputIndex, 2)[1];
  if (args.length !== 1 || (outputIndex !== -1 && !output)) {
    console.error('Usage: fix-appimage.mjs <AppImage> [--output <file>]');
    process.exit(64);
  }
  await fixAppImage(args[0], output);
}
