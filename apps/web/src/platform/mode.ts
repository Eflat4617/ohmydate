/**
 * Which product this bundle is (blueprint 15 §4.2, §7.3).
 *
 * - `server`: the web as it is deployed. Accounts, the login form, sessions,
 *   CSRF, Web Push. Every build is this one unless it was built otherwise.
 * - `desktop`: the page the Rust core serves to the desktop app's window
 *   (15 §1.3). One owner and no accounts: the launch cookie the core set at
 *   `/__boot` is the whole sign-in, so there is no login form, no sign-out
 *   and no push subscription, and a place the core does not serve yet says
 *   so instead of failing (`notReady.ts`).
 *
 * The mode is the Vite mode the bundle was built in: `vite build --mode
 * desktop` (or `vite --mode desktop` for the dev server). Vite replaces
 * `import.meta.env.MODE` with a string literal in every build, so a server
 * build holds `"production" === "desktop"` — false before the page has
 * loaded. Nothing at run time (an address, storage, a response, a header)
 * can turn it on, and nothing here reads anything else.
 */
import type { User } from '../api';

export type AppMode = 'server' | 'desktop';

/** The Vite mode that makes a desktop bundle. Exactly this string; anything else is the server. */
export const DESKTOP_BUILD_MODE = 'desktop';

export function appMode(): AppMode {
  return import.meta.env.MODE === DESKTOP_BUILD_MODE ? 'desktop' : 'server';
}

export function isDesktop(): boolean {
  return appMode() === 'desktop';
}

/**
 * The mock API (`VITE_MOCK=1`) is a service worker. The desktop page never
 * registers one (15 §4.2): its API is the core that served it.
 */
export function mockApiWanted(): boolean {
  return !isDesktop() && import.meta.env.VITE_MOCK === '1';
}

/**
 * Whether an AI can read a line here. The server always says which provider
 * answers (`llmProvider`); the desktop core says nothing until its AI slice
 * lands (15 §7.3 item 4), and then a line is taken as the title it is.
 */
export function aiAvailable(user: Pick<User, 'llmProvider'> | null | undefined): boolean {
  return !(isDesktop() && user?.llmProvider === undefined);
}

/**
 * The address the owner signed in with, for showing. The desktop owner has
 * none: the core's placeholder address is not a person's and is not shown.
 */
export function ownerEmail(user: Pick<User, 'email'> | null | undefined): string | null {
  if (isDesktop()) return null;
  return user?.email ?? null;
}
