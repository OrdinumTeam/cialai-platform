// SPDX-License-Identifier: Apache-2.0
// Tema MUI com métrica e cores de macOS: fonte de sistema, controles de 28 px,
// raio 6, sem ripple e sem elevação Material. O MUI fica só em diálogos,
// drawer, toasts e layout.

import { createTheme } from '@mui/material/styles';

export const MAC_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const LIGHT = {
  accent: '#E23B84', accentDark: '#C9317A', accentLight: '#FF7AB2', primaryText: '#3A1B33', info: '#1a4fa0',
  bg: '#ffffff', surface: '#ffffff',
  label: '#1d1d1f', label2: '#6e6e73', label3: '#a1a1a6',
  separator: 'rgba(0,0,0,.07)', separatorStrong: 'rgba(0,0,0,.12)',
  success: '#1f9d5b', warning: '#c27a00', error: '#d83a3a',
};

const DARK = {
  accent: '#FF7AB2', accentDark: '#FF8FC0', accentLight: '#FFD6E6', primaryText: '#3A1B33', info: '#4a8ae6',
  bg: '#1c1c1e', surface: '#262628',
  label: '#f5f5f7', label2: 'rgba(235,235,245,.62)', label3: 'rgba(235,235,245,.4)',
  separator: 'rgba(255,255,255,.08)', separatorStrong: 'rgba(255,255,255,.15)',
  success: '#3ccf76', warning: '#f0a629', error: '#ff5c5c',
};

function buildShadows() {
  const popover = '0 8px 28px rgba(0,0,0,.14), 0 0 0 .5px rgba(0,0,0,.08)';
  const sheet = '0 18px 50px rgba(0,0,0,.22), 0 0 0 .5px rgba(0,0,0,.1)';
  return Array.from({ length: 25 }, (_, index) => {
    if (index === 0) return 'none';
    if (index < 8) return '0 1px 3px rgba(0,0,0,.08)';
    if (index < 16) return popover;
    return sheet;
  });
}

export function buildMacTheme(mode) {
  const dark = mode === 'dark';
  const c = dark ? DARK : LIGHT;

  return createTheme({
    palette: {
      mode: dark ? 'dark' : 'light',
      primary: { main: c.accent, dark: c.accentDark, light: c.accentLight, contrastText: c.primaryText },
      success: { main: c.success },
      warning: { main: c.warning },
      error: { main: c.error },
      info: { main: c.info },
      divider: c.separator,
      background: { default: c.bg, paper: c.surface },
      text: { primary: c.label, secondary: c.label2, disabled: c.label3 },
    },
    typography: {
      fontFamily: 'var(--mac-font)',
      fontSize: 13,
      h5: { fontSize: 17, fontWeight: 600 },
      h6: { fontSize: 15, fontWeight: 600 },
      subtitle1: { fontSize: 13, fontWeight: 600 },
      subtitle2: { fontSize: 12, fontWeight: 600 },
      body1: { fontSize: 13 },
      body2: { fontSize: 12 },
      caption: { fontSize: 11 },
      button: { textTransform: 'none', fontWeight: 500, fontSize: 13 },
    },
    shape: { borderRadius: 8 },
    shadows: buildShadows(),
    components: {
      MuiButtonBase: { defaultProps: { disableRipple: true } },
      MuiButton: {
        defaultProps: { size: 'small', disableElevation: true },
        styleOverrides: {
          root: { minHeight: 30, padding: '0 13px', fontSize: 13, borderRadius: 8, lineHeight: 1 },
          outlined: { borderColor: c.separatorStrong, backgroundColor: c.surface },
          text: { padding: '0 8px' },
        },
      },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 7 } } },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiFormControl: { defaultProps: { size: 'small' } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: { borderRadius: 8, fontSize: 13, backgroundColor: c.surface },
          input: { padding: '5px 8px', height: 18 },
          inputSizeSmall: { padding: '5px 8px', height: 18 },
          notchedOutline: { borderColor: c.separatorStrong },
        },
      },
      MuiInputLabel: { styleOverrides: { root: { fontSize: 13 }, shrink: { fontSize: 13 } } },
      MuiSelect: { styleOverrides: { select: { padding: '5px 28px 5px 8px', minHeight: 'unset' } } },
      MuiMenu: {
        styleOverrides: {
          paper: { borderRadius: 10, border: `1px solid ${c.separator}`, marginTop: 4 },
          list: { padding: 4 },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            fontSize: 13, minHeight: 26, borderRadius: 5, margin: '1px 0', padding: '3px 10px',
            '&.Mui-selected': { backgroundColor: c.accent, color: c.primaryText },
            '&.Mui-selected:hover': { backgroundColor: c.accentDark },
          },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiDialog: {
        defaultProps: { transitionDuration: 220 },
        styleOverrides: { paper: { borderRadius: 14, border: `1px solid ${c.separator}` } },
      },
      MuiDialogTitle: { styleOverrides: { root: { fontSize: 15, fontWeight: 600, padding: '16px 20px 10px' } } },
      MuiDialogContent: { styleOverrides: { root: { padding: '12px 20px 16px', borderColor: c.separator } } },
      MuiDialogActions: { styleOverrides: { root: { padding: '12px 20px 16px', gap: 8 } } },
      MuiDrawer: {
        defaultProps: { transitionDuration: 260 },
        styleOverrides: { paper: { borderLeft: `1px solid ${c.separator}`, boxShadow: 'none', backgroundImage: 'none' } },
      },
      MuiAlert: { styleOverrides: { root: { borderRadius: 12, fontSize: 13, alignItems: 'center', padding: '4px 12px' } } },
      MuiTableCell: { styleOverrides: { root: { padding: '6px 12px', fontSize: 13, borderColor: c.separator } } },
      MuiTooltip: { styleOverrides: { tooltip: { fontSize: 11, borderRadius: 6, padding: '4px 8px' } } },
      MuiCircularProgress: { defaultProps: { size: 18, thickness: 4 } },
      MuiChip: { styleOverrides: { root: { fontSize: 11, height: 22, borderRadius: 999 } } },
      MuiSwitch: { defaultProps: { size: 'small' } },
    },
  });
}
