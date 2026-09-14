// SPDX-License-Identifier: Apache-2.0
import { translate } from '../shared/i18n.js';
// Offsets count bytes, not decoded characters. ACK uses the full input size.
export function beginReplay(cursor, { offset }) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(translate('terminal.restore.invalidHistory'));
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
