// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/scaffold.css';

createRoot(document.getElementById('root')).render(
  <main className="scaffold">
    <div className="scaffold__mark" aria-hidden="true" />
    <h1>Cialai para celular</h1>
    <p>Entrada móvel empacotada pelo desktop. Pareamento ainda não implementado.</p>
  </main>,
);
