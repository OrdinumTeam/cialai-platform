// SPDX-License-Identifier: Apache-2.0
// Offsets count bytes, not decoded characters. ACK uses the full input size.
export function beginReplay(cursor, { offset }) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Histórico do terminal inválido.');
  cursor.outputOffset = offset;
}

export function consumeOutput(cursor, bytes) {
  const offset = cursor.outputOffset || 0;
  const received = cursor.receivedOffset || 0;
  const skip = Math.min(bytes.byteLength, Math.max(0, received - offset));
  cursor.outputOffset = offset + bytes.byteLength;
  cursor.receivedOffset = Math.max(received, cursor.outputOffset);
  return bytes.subarray(skip);
}
