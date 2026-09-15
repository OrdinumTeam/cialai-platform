// SPDX-License-Identifier: Apache-2.0
// Confere a assinatura minisign do atualizador do Tauri contra o arquivo final, como o app instalado faz.
// Uso:
//   node tools/release/verify-updater-signature.mjs <arquivo> [--signature <arquivo.sig>] [--public-key <base64>]
// Sem --public-key vale a chave pública de plugins.updater.pubkey em apps/desktop/src-tauri/tauri.conf.json.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// O .sig do Tauri e a chave pública da configuração são o base64 dos arquivos de texto do minisign.
function minisignLines(value, label) {
  const lines = Buffer.from(value.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
  if (!lines[0]?.startsWith('untrusted comment: ')) throw new Error(`${label} is not a minisign file`);
  return lines;
}

export function parsePublicKey(value) {
  const [, keyLine] = minisignLines(value, 'Public key');
  const raw = Buffer.from(keyLine ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('Public key is not a minisign Ed25519 key');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

export function parseSignature(value) {
  const [, signatureLine, trustedLine, globalLine] = minisignLines(value, 'Signature');
  const raw = Buffer.from(signatureLine ?? '', 'base64');
  const algorithm = raw.subarray(0, 2).toString('latin1');
  if (raw.length !== 74 || !['Ed', 'ED'].includes(algorithm)) throw new Error('Signature is not a minisign Ed25519 signature');
  if (!trustedLine?.startsWith('trusted comment: ')) throw new Error('Signature has no trusted comment');
  const global = Buffer.from(globalLine ?? '', 'base64');
  if (global.length !== 64) throw new Error('Signature has no global signature');
  return {
    prehashed: algorithm === 'ED',
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trustedLine.slice('trusted comment: '.length),
    global,
  };
}

function ed25519(key) {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.toString('base64url') }, format: 'jwk' });
}

// `digest` é o BLAKE2b-512 do arquivo, usado pelas assinaturas pré-hasheadas que o Tauri gera,
// e `data` o conteúdo inteiro, só necessário no formato antigo sem pré-hash.
export function verifyUpdaterSignature({ digest, data, signature, publicKey }) {
  const key = parsePublicKey(publicKey);
  const parsed = parseSignature(signature);
  if (!parsed.keyId.equals(key.keyId)) throw new Error('Signature was made by another key');
  const message = parsed.prehashed ? digest : data;
  if (!message) throw new Error(parsed.prehashed ? 'Missing BLAKE2b-512 digest' : 'Missing file contents');
  const publicKeyObject = ed25519(key.key);
  if (!verify(null, message, publicKeyObject, parsed.signature)) throw new Error('Signature does not match the file');
  const trusted = Buffer.concat([parsed.signature, Buffer.from(parsed.trustedComment, 'utf8')]);
  if (!verify(null, trusted, publicKeyObject, parsed.global)) throw new Error('Trusted comment signature does not match');
  return { trustedComment: parsed.trustedComment };
}

export async function blake2b512(path) {
  const hash = createHash('blake2b512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest();
}

function configPublicKey() {
  const config = new URL('../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url);
  return JSON.parse(readFileSync(config, 'utf8')).plugins.updater.pubkey;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    if (index === -1) return undefined;
    const [, value] = args.splice(index, 2);
    if (!value) throw new Error(`${name} needs a value`);
    return value;
  };
  const signaturePath = option('--signature');
  const publicKey = option('--public-key') ?? configPublicKey();
  const [file] = args;
  if (!file || args.length !== 1) {
    console.error('Usage: verify-updater-signature.mjs <file> [--signature <file.sig>] [--public-key <base64>]');
    process.exit(64);
  }
  const signature = readFileSync(signaturePath ?? `${file}.sig`, 'utf8');
  const prehashed = parseSignature(signature).prehashed;
  const { trustedComment } = verifyUpdaterSignature({
    digest: prehashed ? await blake2b512(file) : undefined,
    data: prehashed ? undefined : readFileSync(file),
    signature,
    publicKey,
  });
  console.log(`PASS updater signature of ${file} matches key ${Buffer.from(parsePublicKey(publicKey).keyId).reverse().toString('hex').toUpperCase()}: ${trustedComment}`);
}
