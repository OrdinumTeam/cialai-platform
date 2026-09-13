// SPDX-License-Identifier: Apache-2.0
import { isMobileShell, requireSensitive } from '../lib/shell.js';
import { openExternal } from '../lib/downloads.js';
import { translate } from './i18n.js';

// Covers ordinary anchors as well as the shared download helpers.
export function installMobileLinks() {
  document.addEventListener('click', async (event) => {
    const anchor = event.target.closest?.('a[href]');
    if (!anchor || event.defaultPrevented) return;
    const url = new URL(anchor.href, location.href);
    if (!isMobileShell() || url.origin === location.origin) return;
    event.preventDefault();
    try {
      await requireSensitive('action', translate('action.openExternal'));
      await openExternal(url.href);
    } catch (error) {
      window.dispatchEvent(new CustomEvent('cialai:mobile-error', { detail: error.message }));
    }
  }, true);
}
