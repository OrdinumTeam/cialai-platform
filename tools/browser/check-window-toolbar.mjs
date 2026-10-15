// SPDX-License-Identifier: Apache-2.0
// Production toolbar geometry and interactions. The bridge below is mocked;
// these checks do not approve native operating-system window behavior.
import assert from 'node:assert/strict';

export async function checkWindowToolbar(page, os) {
  await page.locator('.mac-window.is-booted').waitFor();
  await page.locator('.mac-splash').waitFor({ state: 'detached' });
  const menu = page.locator('.mac-tool--menu');
  const search = page.locator('.mac-tool--search');
  const controls = page.locator('.mac-window-controls');
  const sidebarToggle = page.locator('.mac-toolbar__leading>.mac-tool');

  assert.deepEqual(await controls.locator('button').evaluateAll((buttons) => buttons.map((button) => button.dataset.control)),
    os === 'macos' ? ['close', 'minimize', 'fullscreen'] : ['minimize', 'maximize', 'close']);
  assert.equal(await page.locator('.mac-window-resize-handle').count(), os === 'linux' ? 8 : 0);
  if (os === 'macos') {
    assert.deepEqual(await controls.locator('button').evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button, '::before').backgroundColor)),
      ['rgb(255, 95, 87)', 'rgb(254, 188, 46)', 'rgb(40, 200, 64)']);
  }

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    for (const width of [880, 1040, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const hidden of [false, true]) {
        const currentlyHidden = await page.locator('.mac-sidebar').evaluate((element) => element.classList.contains('is-hidden'));
        if (currentlyHidden !== hidden) await sidebarToggle.click();
        await page.waitForFunction((collapsed) => Math.abs(document.querySelector('.mac-toolbar').getBoundingClientRect().left - (collapsed ? 0 : 232)) < 1, hidden);
        const geometry = await page.locator('.mac-toolbar').evaluate((toolbar) => {
          const rect = (selector) => {
            const element = toolbar.querySelector(selector);
            const { x, y, width, height } = element.getBoundingClientRect();
            return { x, y, width, height, center: y + height / 2 };
          };
          return {
            toolbar: toolbar.getBoundingClientRect().toJSON(),
            search: rect('.mac-tool--search'), menu: rect('.mac-tool--menu'), controls: rect('.mac-window-controls'),
            buttons: [...toolbar.querySelectorAll('.mac-window-control')].map((button) => {
              const { x, y, width, height } = button.getBoundingClientRect();
              return { x, y, width, height };
            }),
            title: rect('.mac-toolbar__titles'), leading: rect('.mac-toolbar__leading'),
            dragGap: document.querySelector('.mac-sidebar__drag').getBoundingClientRect().height,
            paddingLeft: getComputedStyle(toolbar).paddingLeft,
          };
        });
        const context = `${os} ${theme} ${width}px sidebar ${hidden ? 'hidden' : 'visible'}`;
        assert.equal(geometry.toolbar.height, 52, `${context}: toolbar height`);
        assert.equal(geometry.dragGap, 0, `${context}: old traffic-light spacer`);
        assert.equal(geometry.paddingLeft, '10px', `${context}: left padding`);
        assert.ok(geometry.search.x + geometry.search.width <= geometry.menu.x + 1, `${context}: search before menu`);
        assert.ok(geometry.menu.x + geometry.menu.width <= geometry.controls.x + 1, `${context}: menu before controls`);
        assert.ok(Math.abs(geometry.search.center - geometry.menu.center) <= 1, `${context}: search and menu alignment`);
        assert.ok(Math.abs(geometry.menu.center - geometry.controls.center) <= 1, `${context}: controls alignment`);
        assert.ok(geometry.title.x + geometry.title.width <= geometry.search.x + 1, `${context}: title overlap`);
        for (const button of geometry.buttons) {
          assert.ok(button.x >= geometry.toolbar.x && button.x + button.width <= geometry.toolbar.right + 1, `${context}: clipped control`);
          assert.ok(button.y >= geometry.toolbar.y && button.y + button.height <= geometry.toolbar.bottom + 1, `${context}: control outside toolbar`);
        }
        await menu.click();
        await page.getByRole('menu').waitFor();
        await page.keyboard.press('Escape');
        await page.getByRole('menu').waitFor({ state: 'detached' });
        await search.click();
        await page.locator('.mac-palette').waitFor();
        await page.waitForFunction(() => document.activeElement === document.querySelector('.mac-palette input'));
        await page.keyboard.press('Escape');
        await page.locator('.mac-palette').waitFor({ state: 'detached' });
      }
    }
  }

  // Exercise button dispatch through a minimal mocked native bridge.
  await page.evaluate(() => {
    window.__toolbarCalls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command, args) => {
        window.__toolbarCalls.push({ command, args });
        if (command === 'plugin:window|is_fullscreen') return false;
        return null;
      },
    };
  });
  try {
    for (const action of ['minimize', os === 'macos' ? 'fullscreen' : 'maximize', 'close']) {
      await controls.locator(`[data-control="${action}"]`).click();
    }
    if (os === 'linux') await page.locator('.mac-window-resize-handle.is-SouthEast').dispatchEvent('pointerdown', { button: 0 });
    const expected = ['plugin:window|minimize', os === 'macos' ? 'plugin:window|set_fullscreen' : 'plugin:window|toggle_maximize', 'plugin:window|close'];
    if (os === 'linux') expected.push('plugin:window|start_resize_dragging');
    await page.waitForFunction((commands) => commands.every((command) => window.__toolbarCalls.some((call) => call.command === command)), expected);
    const calls = await page.evaluate(() => window.__toolbarCalls);
    if (os === 'macos') assert.equal(calls.find((call) => call.command === 'plugin:window|set_fullscreen').args.value, true);
    if (os === 'linux') assert.equal(calls.find((call) => call.command === 'plugin:window|start_resize_dragging').args.value, 'SouthEast');
  } finally {
    await page.evaluate(() => { delete window.__TAURI_INTERNALS__; delete window.__toolbarCalls; });
  }
  return `PASS toolbar ${os}: 12 layouts, menu, search, controls and simulated window bridge`;
}
