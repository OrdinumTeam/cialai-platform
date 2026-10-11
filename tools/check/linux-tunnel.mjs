// SPDX-License-Identifier: Apache-2.0
// Sobe o sidecar `cialai-tunnel` num Linux real, dentro de um container Ubuntu 22.04 com Avahi,
// e repete o que o supervisor do desktop faz ao abrir: handshake stdio, `net.start` com a borda
// injetada e `pair.begin`. Falha quando o ouvinte direto não fica em `listening` ou quando
// `pair.begin` não devolve payload. O Tor fica desligado: o que se confere aqui é a parte
// exclusiva do Linux, chave de identidade, porta UDP, DNS-SD ao lado do Avahi e a borda.
//
//   node tools/check/linux-tunnel.mjs                   compila para a arquitetura do daemon Docker e roda
//   node tools/check/linux-tunnel.mjs --arch amd64      força a arquitetura do binário e do container
//   node tools/check/linux-tunnel.mjs --work <pasta>    pasta de trabalho do binário e do roteiro
//   node tools/check/linux-tunnel.mjs --keep            mantém a pasta de trabalho ao final
//
// Sai com 2 quando Docker ou Go não estão disponíveis, para o chamador distinguir "não rodou" de
// "falhou". A imagem `cialai-linux-tunnel-check` é construída uma vez e reaproveitada.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PROTOCOL_VERSION = 1;
const IMAGE_BASE = 'ubuntu:22.04';
const GO_ARCHES = Object.freeze({ x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' });

function parseArgs(argv) {
  const options = { arch: null, work: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--arch') options.arch = argv[++index];
    else if (value === '--work') options.work = argv[++index];
    else if (value === '--keep') options.keep = true;
    else throw new Error(`argumento desconhecido: ${value}`);
  }
  if (options.arch && !['amd64', 'arm64'].includes(options.arch)) throw new Error('--arch aceita amd64 ou arm64');
  return options;
}

function skip(message) {
  console.log(`SKIP linux tunnel: ${message}`);
  process.exit(2);
}

function fail(message) {
  console.error(`FAIL linux tunnel: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

// Arquitetura do daemon: um binário da arquitetura errada só rodaria por emulação.
function dockerArchitecture() {
  const info = run('docker', ['info', '--format', '{{.OSType}} {{.Architecture}}']);
  if (info.status !== 0) skip(`Docker indisponível: ${(info.stderr || info.stdout).trim()}`);
  const [os, architecture] = info.stdout.trim().split(/\s+/);
  if (os !== 'linux') skip(`o daemon Docker não roda containers Linux: ${os}`);
  const arch = GO_ARCHES[architecture];
  if (!arch) skip(`arquitetura do daemon sem alvo Go: ${architecture}`);
  return arch;
}

function buildSidecar(arch, output) {
  const result = run('go', ['build', '-trimpath', '-mod=readonly', '-ldflags=-s -w', '-o', output, './cmd/cialai-tunnel'], {
    cwd: `${root}packages/tunnel-core`,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: arch },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) fail(`go build linux/${arch} saiu com ${result.status}`);
  chmodSync(output, 0o755);
}

// Imagem com Avahi e D-Bus por cima do Ubuntu 22.04, a mesma base de tools/docker/linux-desktop.Dockerfile.
function ensureImage(arch) {
  const tag = `cialai-linux-tunnel-check:ubuntu-22.04-${arch}`;
  if (run('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0) return tag;
  const dockerfile = [
    `FROM ${IMAGE_BASE}`,
    'ENV DEBIAN_FRONTEND=noninteractive',
    'RUN apt-get update && apt-get install -y --no-install-recommends avahi-daemon dbus ca-certificates iproute2 && rm -rf /var/lib/apt/lists/*',
    '',
  ].join('\n');
  console.log(`construindo ${tag}`);
  const result = run('docker', ['build', '--platform', `linux/${arch}`, '-t', tag, '-'], { input: dockerfile, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.status !== 0) fail(`docker build saiu com ${result.status}`);
  return tag;
}

// O roteiro do container prepara D-Bus, Avahi e um bundle mínimo do celular, e passa o stdio ao
// sidecar pelo exec: ele vira o PID 1, que é o pai informado em --parent-pid.
const ENTRY = `#!/bin/sh
set -eu
mkdir -p /run/dbus /tmp/state /tmp/mobile
printf '<!doctype html><title>Cialai</title>\\n' > /tmp/mobile/mobile.html
if dbus-daemon --system --fork >/dev/null 2>&1; then echo '[check] dbus ativo' >&2; else echo '[check] dbus indisponível' >&2; fi
if avahi-daemon -D --no-chroot --no-rlimits >/dev/null 2>&1; then echo '[check] avahi ativo' >&2; else echo '[check] avahi indisponível' >&2; fi
exec /check/cialai-tunnel serve-stdio --state-dir /tmp/state --parent-pid 1
`;

// Cliente mínimo do protocolo stdio do supervisor: uma linha JSON por quadro, respostas casadas
// pelo id e eventos guardados para inspeção.
class Sidecar {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.stderr = [];
    this.exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    this.helloEvent = new Promise((resolve) => { this.resolveHello = resolve; });
    createInterface({ input: child.stdout }).on('line', (line) => this.accept(line));
    createInterface({ input: child.stderr }).on('line', (line) => { this.stderr.push(line); if (this.stderr.length > 200) this.stderr.shift(); });
  }

  accept(line) {
    let frame;
    try { frame = JSON.parse(line); } catch { this.stderr.push(`[check] quadro ilegível: ${line.slice(0, 200)}`); return; }
    if (typeof frame.event === 'string') {
      this.events.push(frame);
      if (frame.event === 'hello') this.resolveHello(frame);
      return;
    }
    const waiter = this.pending.get(frame.id);
    if (!waiter) return;
    this.pending.delete(frame.id);
    if (frame.ok) waiter.resolve(frame.result);
    else waiter.reject(new Error(`${frame.error?.code}: ${frame.error?.message}`));
  }

  call(cmd, args, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${cmd} sem resposta em ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} em ${ms} ms`)), ms))]);
}

async function exercise(sidecar, arch) {
  const hello = await withTimeout(sidecar.helloEvent, 30_000, 'o sidecar não anunciou hello');
  if (hello.data?.protocol !== PROTOCOL_VERSION) throw new Error(`hello anunciou protocolo ${hello.data?.protocol}`);
  const negotiated = await sidecar.call('hello', { protocol: PROTOCOL_VERSION }, 10_000);
  if (negotiated?.protocol !== PROTOCOL_VERSION) throw new Error(`handshake devolveu ${JSON.stringify(negotiated)}`);

  const status = await sidecar.call('net.start', {
    desktopName: `Linux ${arch} de teste`,
    requireApproval: false,
    tor: false,
    staticDir: '/tmp/mobile',
    bridgeUrl: 'http://127.0.0.1:47831/',
    proxySecret: 'segredo-do-check-linux',
  }, 30_000);
  const direct = status?.direct || {};
  if (direct.state !== 'listening') throw new Error(`direct.state = ${direct.state}; net.state = ${status?.state}; erro = ${JSON.stringify(status?.error)}`);
  if (!['ready', 'degraded'].includes(status.state)) throw new Error(`net.state = ${status.state}`);
  if (!status.desktop?.id || !status.desktop?.publicKey) throw new Error('net.start sem identidade do computador');

  const pair = await sidecar.call('pair.begin', { ttlSeconds: 60 }, 15_000);
  if (typeof pair?.payload !== 'string' || !pair.payload.length) throw new Error(`pair.begin sem payload: ${JSON.stringify(pair)}`);
  if (typeof pair.pairId !== 'string' || !pair.pairId) throw new Error('pair.begin sem pairId');
  await sidecar.call('pair.cancel', { pairId: pair.pairId }, 10_000);

  const again = await sidecar.call('net.status', {}, 10_000);
  if (again?.direct?.state !== 'listening') throw new Error(`net.status depois do pareamento: direct.state = ${again?.direct?.state}`);

  await sidecar.call('shutdown', {}, 10_000);
  const exit = await withTimeout(sidecar.exit, 15_000, 'o sidecar não saiu depois do shutdown');
  if (exit.code !== 0) throw new Error(`o sidecar saiu com código ${exit.code} e sinal ${exit.signal}`);
  return { status, pair, exit };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (run('go', ['version']).status !== 0) skip('Go indisponível');
  const arch = options.arch || dockerArchitecture();
  const work = options.work ? options.work : mkdtempSync(join(tmpdir(), 'cialai-linux-tunnel-'));
  mkdirSync(work, { recursive: true });
  const binary = join(work, 'cialai-tunnel');
  const cleanup = () => { if (!options.keep && !options.work && existsSync(work)) rmSync(work, { recursive: true, force: true }); };
  try {
    console.log(`compilando o sidecar linux/${arch} em ${binary}`);
    buildSidecar(arch, binary);
    writeFileSync(join(work, 'entry.sh'), ENTRY, { mode: 0o755 });
    const image = ensureImage(arch);

    const child = spawn('docker', ['run', '--rm', '-i', '--platform', `linux/${arch}`, '-v', `${work}:/check:ro`, image, 'sh', '/check/entry.sh'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const sidecar = new Sidecar(child);
    let outcome;
    try {
      outcome = await exercise(sidecar, arch);
    } catch (error) {
      child.kill('SIGKILL');
      console.error(sidecar.stderr.slice(-40).join('\n'));
      fail(error.message);
    }
    const { status, pair } = outcome;
    const candidates = (status.direct.candidates || []).map((candidate) => `${candidate.kind} ${candidate.addr}`);
    const avahi = sidecar.stderr.find((line) => line.startsWith('[check] avahi')) || '[check] avahi sem registro';
    console.log(`net.state ${status.state}; direct ${status.direct.state} na porta ${status.direct.port}; edge ${status.edge?.state}; mdns ${status.mdns?.state}; tor ${status.tor?.state}; ${avahi.slice(8)}`);
    console.log(`endereços anunciados: ${candidates.length ? candidates.join(', ') : 'nenhum'}`);
    console.log(`PASS linux tunnel: sidecar linux/${arch} em ${IMAGE_BASE} negociou o protocolo ${PROTOCOL_VERSION}, abriu o ouvinte direto e pair.begin devolveu ${pair.payload.length} caracteres de payload`);
  } finally {
    cleanup();
  }
}

main().catch((error) => fail(error.message));
