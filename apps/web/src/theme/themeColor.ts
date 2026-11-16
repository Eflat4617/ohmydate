import type { ThemeScheme } from './theme';

/**
 * The colour a phone's browser gives its own bar, and an installed app its
 * status bar (HOLO-07): the page's ground, so the bar and the page are one
 * surface. `<meta name="theme-color">` and the web app manifest take sRGB
 * hex, not `oklch()`, so the two grounds of `styles/tokens.css`
 * (`--color-ground`, dark and light) are written out here; a test converts
 * the tokens and fails when these drift from them
 * (test/holo-phone-install.spec.ts). The manifest carries the dark one: dark
 * is the default theme, and the manifest is read before anyone has chosen.
 */
export const THEME_COLOR: Readonly<Record<ThemeScheme, string>> = {
  dark: '#070a08',
  light: '#f0f4ef',
};

/**
 * Put the scheme's colour on the page's theme-colour tag. The tag is in the
 * server bundle's index.html only: the desktop bundle has none, and none is
 * made here.
 */
export function applyThemeColor(scheme: ThemeScheme): void {
  if (typeof document === 'undefined') return;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[scheme]);
}
