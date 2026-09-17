// SPDX-License-Identifier: Apache-2.0
import { translate } from '../shared/i18n.js';
// Offsets count bytes, not decoded characters. ACK uses the full input size.
export function beginReplay(cursor, { offset, length = 0 }) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(translate('terminal.restore.invalidHistory'));
  cursor.outputOffset = offset;
  // Marca de replay em andamento: enquanto o histórico volta ao xterm, o
  // reparse faz o xterm responder sozinho a ESC[6n e ESC[c, e essas respostas
  // não podem sair por onData como se fossem digitação. A marca fica ligada
  // antes de qualquer term.write do replay e é desligada só quando o xterm
  // termina de processar os bytes. Histórico vazio não liga a marca, senão ela
  // nunca desligaria por falta de um quadro para processar.
  cursor.replayRemaining = Number.isSafeInteger(length) && length > 0 ? length : 0;
  cursor.replaying = cursor.replayRemaining > 0;
}

export function consumeOutput(cursor, bytes) {
  const offset = cursor.outputOffset || 0;
  const received = cursor.receivedOffset || 0;
  const skip = Math.min(bytes.byteLength, Math.max(0, received - offset));
  cursor.outputOffset = offset + bytes.byteLength;
  cursor.receivedOffset = Math.max(received, cursor.outputOffset);
  return bytes.subarray(skip);
}
