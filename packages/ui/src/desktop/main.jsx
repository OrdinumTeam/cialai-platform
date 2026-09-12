// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './macos.css';
import DesktopApp from './DesktopApp.jsx';

function platformName() {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('mac')) return 'macos';
  if (agent.includes('win')) return 'windows';
  if (agent.includes('linux')) return 'linux';
  return 'unknown';
}

document.documentElement.dataset.platform = platformName();
if (new URLSearchParams(window.location.search).get('motion') === '0') document.documentElement.dataset.motion = 'none';
createRoot(document.getElementById('root')).render(<DesktopApp />);

if (new URLSearchParams(window.location.search).get('cialai_selftest')) {
  const script = '/scripts/selftest-app.js';
  import(/* @vite-ignore */ script).catch((error) => console.error('[autoteste]', error));
}
