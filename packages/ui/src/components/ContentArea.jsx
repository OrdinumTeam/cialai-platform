// SPDX-License-Identifier: Apache-2.0
import React, { Suspense } from 'react';
import { DataState } from './ui.jsx';

export default function ContentArea({ ViewComponent, viewId }) {
  return (
    <Suspense fallback={<div className="view active"><DataState type="loading" message="Carregando…" /></div>}>
      <ViewComponent key={viewId} />
    </Suspense>
  );
}
