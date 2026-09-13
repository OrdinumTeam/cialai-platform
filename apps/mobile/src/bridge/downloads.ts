import { isSafeDownloadUrl } from '../config/url';
import type { DataDownloadRequest, RemoteDownloadRequest } from './messages';

export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'application/json': ['.json'],
  'application/pdf': ['.pdf'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/zip': ['.zip'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'text/csv': ['.csv'],
  'text/markdown': ['.md'],
  'text/plain': ['.txt']
};

const EXTENSION_MIMES = Object.fromEntries(
  Object.entries(MIME_EXTENSIONS).flatMap(([mime, extensions]) =>
    extensions.map(extension => [extension, mime])
  )
) as Readonly<Record<string, string>>;

export type PreparedDownload = { name: string; mime: string; bytes: Uint8Array };
export type PreparedRemoteDownload = Omit<PreparedDownload, 'bytes'> & { url: string };

function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

function safeFileName(input: string, extension: string): string {
  const leaf = input.normalize('NFC').split(/[\\/]/).at(-1) ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '').trim();
  const base = cleaned.replace(/\.[^.]*$/, '').replace(/^[. ]+|[. ]+$/g, '') || 'download';
  return `${base.slice(0, 100 - extension.length).trim() || 'download'}${extension}`;
}

function normalizeMime(rawMime: string): string {
  return rawMime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function validateMetadata(name: string, rawMime: string): { name: string; mime: string } {
  const mime = normalizeMime(rawMime);
  const extensions = MIME_EXTENSIONS[mime];
  if (!extensions) throw new Error('Este tipo de arquivo não é permitido.');
  const lowerName = name.toLowerCase();
  const extension = extensions.find(candidate => lowerName.endsWith(candidate)) ?? extensions[0];
  if (!extension) throw new Error('Este tipo de arquivo não é permitido.');
  return { name: safeFileName(name, extension), mime };
}

export function prepareDataDownload(message: DataDownloadRequest): PreparedDownload {
  const mime = normalizeMime(message.mime);
  const metadataForFile = validateMetadata(message.name, mime);
  if (!message.dataUrl.startsWith('data:')) throw new Error('O conteúdo do arquivo não é válido.');
  const comma = message.dataUrl.indexOf(',');
  const metadata = comma > 5 ? message.dataUrl.slice(5, comma).split(';') : [];
  const declaredMime = normalizeMime(metadata.shift() ?? '');
  const encoding = metadata.pop();
  const validParameters = metadata.every(parameter => /^[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+:-]+$/.test(parameter));
  if (declaredMime !== mime || encoding !== 'base64' || !validParameters) {
    throw new Error('O conteúdo do arquivo não corresponde ao tipo informado.');
  }
  const base64 = message.dataUrl.slice(comma + 1);
  if (decodedByteLength(base64) > MAX_DOWNLOAD_BYTES) throw new Error('O arquivo excede o limite de 8 MB.');
  if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('O conteúdo do arquivo está corrompido.');
  }
  const binary = globalThis.atob(base64);
  return { ...metadataForFile, bytes: Uint8Array.from(binary, character => character.charCodeAt(0)) };
}

export function prepareRemoteDownload(message: RemoteDownloadRequest, allowDevelopmentLoopback = false): PreparedRemoteDownload {
  const lowerName = message.name.toLowerCase();
  const inferredExtension = Object.keys(EXTENSION_MIMES).sort((a, b) => b.length - a.length)
    .find(extension => lowerName.endsWith(extension));
  const inferredMime = inferredExtension ? EXTENSION_MIMES[inferredExtension] : undefined;
  const rawMime = message.mime?.trim() || inferredMime;
  if (!rawMime) throw new Error('Não foi possível identificar o tipo do arquivo.');
  const metadata = validateMetadata(message.name, rawMime);
  if (!isSafeDownloadUrl(message.url, allowDevelopmentLoopback)) throw new Error('O endereço do download não é seguro.');
  return { ...metadata, url: message.url };
}
