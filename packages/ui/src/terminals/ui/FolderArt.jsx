// SPDX-License-Identifier: Apache-2.0
// Pasta com folhas das referências, o mesmo desenho do aplicativo nativo
// (apps/mobile/src/ui/Illustrations.tsx). As cores vêm das variáveis
// --phone-tint-* em Terminais.css, uma por tom, claras e escuras.
import React from 'react';
import { projectTint } from '../project-tint.js';

export default function FolderArt({ name, width = 112 }) {
  const tint = projectTint(name);
  return (
    <svg className={`phone-folder-art phone-folder-art--${tint}`} width={width} height={Math.round(width * 0.62)} viewBox="0 0 120 74" aria-hidden="true" focusable="false">
      <path className="phone-folder-art__back" d="M14 18 Q14 12 20 12 L46 12 L54 20 L98 20 Q104 20 104 26 L104 62 L14 62 Z" />
      <rect className="phone-folder-art__paper" x="34" y="10" width="36" height="44" rx="4" transform="rotate(-7 52 32)" />
      <rect className="phone-folder-art__paper" x="52" y="12" width="36" height="44" rx="4" transform="rotate(6 70 34)" />
      <rect className="phone-folder-art__ink" x="59" y="20" width="22" height="3" rx="1.5" transform="rotate(6 70 34)" />
      <rect className="phone-folder-art__ink" x="59" y="27" width="18" height="3" rx="1.5" transform="rotate(6 70 34)" />
      <rect className="phone-folder-art__ink" x="59" y="34" width="24" height="3" rx="1.5" transform="rotate(6 70 34)" />
      <path className="phone-folder-art__front" d="M8 34 Q8 30 12 30 L108 30 Q112 30 111 34 L106 66 Q105 70 101 70 L19 70 Q15 70 14 66 Z" />
    </svg>
  );
}
