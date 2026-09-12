// SPDX-License-Identifier: Apache-2.0
import { isPhone } from '../lib/shell.js';

// Explicitly mark business mutation controls at their owning view. The phone
// keeps the same data and navigation without mounting desktop edit workflows.
export default function DesktopOnly({ children }) {
  return isPhone() ? null : children;
}
