import type { Plugin } from 'vite';

/**
 * HOLO-07: what makes the server's web installable on a phone lives in one
 * marked block of index.html — the manifest link, the icons, the browser
 * bar's colour. The files it points at are in `public/`, which only the
 * server bundle carries (vite.config.ts).
 *
 * The desktop bundle is a page inside the desktop app's own window: there is
 * nothing to install, the core serves no such files (a missing file is a 404,
 * blueprint 15 §1.3), and its head stays as it was. So in desktop mode the
 * block is cut out before Vite reads the document — in the build and on the
 * dev server alike.
 */
export const INSTALL_BLOCK = /[ \t]*<!-- install:start[\s\S]*?<!-- install:end -->[ \t]*\r?\n?/g;

const INSTALL_MARKS = /install:(?:start|end)/;

/** The document without its install block. Throws when the block is not there to cut. */
export function stripInstallHead(html: string): string {
  const stripped = html.replace(INSTALL_BLOCK, '');
  if (stripped === html || INSTALL_MARKS.test(stripped)) {
    throw new Error('index.html: the install block (<!-- install:start … install:end -->) is missing or unbalanced');
  }
  return stripped;
}

export function desktopWithoutInstallHead(): Plugin {
  return {
    name: 'ohmydate:desktop-without-install-head',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => stripInstallHead(html),
    },
  };
}
