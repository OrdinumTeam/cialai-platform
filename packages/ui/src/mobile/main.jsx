// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../desktop/macos.css';
import './mobile.css';
import '../desktop/brand.css';
import * as remote from '../lib/remote.js';
import { installMobileLinks } from './links.js';
import MobileApp from './MobileApp.jsx';

const params = new URLSearchParams(location.search);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (params.get('motion') === '0' || matchMedia('(prefers-reduced-motion: reduce)').matches) document.documentElement.dataset.motion = 'none';
const bridge = params.get('bridge') || (!loopback ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/pty` : '');
if (bridge) remote.configure({ url: bridge });
installMobileLinks();
createRoot(document.getElementById('root')).render(<MobileApp />);
