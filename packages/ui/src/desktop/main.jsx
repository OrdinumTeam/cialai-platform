// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './macos.css';
import './brand.css';
import DesktopApp from './DesktopApp.jsx';
import { initPlatform } from '../lib/platform.js';

await initPlatform();
if (new URLSearchParams(window.location.search).get('motion') === '0') document.documentElement.dataset.motion = 'none';
createRoot(document.getElementById('root')).render(<DesktopApp />);

if (new URLSearchParams(window.location.search).get('cialai_selftest')) {
  import('../../../../tools/selftest/selftest-app.js').catch((error) => console.error('[autoteste]', error));
}
