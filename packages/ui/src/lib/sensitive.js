// SPDX-License-Identifier: Apache-2.0
// UI binding for the shared fail-closed mobile command policy.

import { createSensitiveAuthorizer } from '@cialai/protocol/sensitive';
import { onShellLock, requireSensitive } from './shell.js';

const authorizer = createSensitiveAuthorizer({ requireSensitive, onLock: onShellLock });

export const authorizeNative = authorizer.authorize;
export const resetTerminalAuthorization = authorizer.reset;
