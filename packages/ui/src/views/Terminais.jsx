// SPDX-License-Identifier: Apache-2.0
// View Terminais: o estudio de sessoes, trabalho e arquivos. As sessoes, os
// terminais e o estado do editor vivem no runtime em terminals/runtime.js e
// sobrevivem a troca de secao; esta view so monta o estudio.

import React from 'react';
import { isPhone } from '../lib/shell.js';
import PhoneWorkbench from '../terminals/ui/PhoneWorkbench.jsx';
import Workbench from '../terminals/ui/Workbench.jsx';
import './Terminais.css';

export default function Terminais() {
  return isPhone() ? <PhoneWorkbench /> : <Workbench />;
}
