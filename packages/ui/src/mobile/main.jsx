// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import '../desktop/macos.css';
import './mobile.css';
import '../desktop/brand.css';
import { remoteBridgeUrl } from '@cialai/protocol/native';
import * as remote from '../lib/remote.js';
import { installMobileLinks } from './links.js';
import MobileApp from './MobileApp.jsx';

const params = new URLSearchParams(location.search);
if (params.get('motion') === '0' || matchMedia('(prefers-reduced-motion: reduce)').matches) document.documentElement.dataset.motion = 'none';
const bridge = remoteBridgeUrl(location, params.get('bridge') || '');
if (bridge) remote.configure({ url: bridge });
installMobileLinks();
createRoot(document.getElementById('root')).render(<MobileApp />);
