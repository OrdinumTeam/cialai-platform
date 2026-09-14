// SPDX-License-Identifier: Apache-2.0
import common from './common.js';
import shared from './shared.js';
import desktop from './desktop.js';
import mobile from './mobile.js';
import terminal from './terminal.js';

export default Object.freeze({ ...common, ...shared, ...desktop, ...mobile, ...terminal });
