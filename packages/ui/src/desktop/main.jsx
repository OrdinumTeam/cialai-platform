// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/scaffold.css';

document.documentElement.dataset.platform = navigator.userAgent.includes('Mac') ? 'macos' : 'unknown';

createRoot(document.getElementById('root')).render(
  <main className="scaffold">
    <div className="scaffold__mark" aria-hidden="true" />
    <h1>Cialai</h1>
    <p>Casca do desktop pronta. A extração do estúdio começa na próxima tarefa.</p>
  </main>,
);
