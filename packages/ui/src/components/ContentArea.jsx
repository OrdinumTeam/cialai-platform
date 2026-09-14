// SPDX-License-Identifier: Apache-2.0
import React, { Suspense } from 'react';
import { translate } from '../shared/i18n.js';
import { DataState } from './ui.jsx';

export default function ContentArea({ ViewComponent, viewId }) {
  return (
    <Suspense fallback={<div className="view active"><DataState type="loading" message={translate('shared.state.loading')} /></div>}>
      <ViewComponent key={viewId} />
    </Suspense>
  );
}
