// SPDX-License-Identifier: Apache-2.0
// Frameless Linux windows start resize dragging through the compositor.
// Windows and macOS retain their native resize borders.
import React, { useEffect, useState } from 'react';
import { watchFullscreen, windowControls } from '../lib/native.js';
import { platform } from '../lib/platform.js';

const DIRECTIONS = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'];

export default function WindowResizeHandles() {
  const linux = platform().os === 'linux';
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!linux) return undefined;
    let disposed = false;
    const releases = [];
    for (const [watch, update] of [[windowControls.onMaximizedChange, setMaximized], [watchFullscreen, setFullscreen]]) {
      watch((value) => { if (!disposed) update(value); })
        .then((release) => { if (disposed) release(); else releases.push(release); })
        .catch(() => {});
    }
    return () => { disposed = true; releases.forEach((release) => release()); };
  }, [linux]);
  if (!linux || maximized || fullscreen) return null;
  const resize = (event, direction) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    windowControls.startResizeDragging(direction).catch(() => {});
  };
  return DIRECTIONS.map((direction) => <div key={direction} className={`mac-window-resize-handle is-${direction}`} data-tauri-drag-region="false" aria-hidden="true" onPointerDown={(event) => resize(event, direction)} />);
}
