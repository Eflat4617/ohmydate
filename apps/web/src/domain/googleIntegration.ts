/**
 * CAL-04 — the Google Calendar settings screen, the parts that need no Vue:
 * which return values of the OAuth callback exist, which consent URLs the
 * browser may be sent to, the reminder choices, the settings draft and the
 * literal setup facts (paths, commands) the screen repeats from
 * `docs/user/Google-캘린더-연동-설정.md`.
 *
 * Pure: no DOM, no clock, no requests.
 */

/** `?google=<result>` on `/settings/calendar` after Google sends the browser back (08 §2.11). */
export const GOOGLE_CALLBACK_RESULTS = ['connected', 'denied', 'error'] as const;

export type GoogleCallbackResult = (typeof GOOGLE_CALLBACK_RESULTS)[number];

/** The callback result in a query value, or `null` when it is not one. */
export function googleCallbackResult(value: unknown): GoogleCallbackResult | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && (GOOGLE_CALLBACK_RESULTS as readonly string[]).includes(raw)
    ? (raw as GoogleCallbackResult)
    : null;
}

/** Google's consent screen. The server only ever answers with this host. */
const GOOGLE_CONSENT_ORIGIN = 'https://accounts.google.com';

/**
 * Whether the browser may be sent to `url` to give consent: Google's consent
 * host over https, or this app's own origin (the mock server's stand-in).
 * Anything else — another host, `javascript:`, a relative or unreadable value
 * — is refused, so a wrong answer can never move the page somewhere else.
 */
export function isAllowedAuthorizationUrl(url: unknown, appOrigin: string): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.origin === GOOGLE_CONSENT_ORIGIN) return true;
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === appOrigin;
}

/** Reminder lead of the events sent to the phone, in minutes before; `null` = no popup. */
export const REMINDER_CHOICES: readonly (number | null)[] = [null, 0, 5, 10, 15, 30, 60];

/** The choices the select offers: the fixed ones plus the stored value when it is another (kept, not lost). */
export function reminderChoices(current: number | null): (number | null)[] {
  if (REMINDER_CHOICES.includes(current)) return [...REMINDER_CHOICES];
  const extra = current as number;
  return [null, ...[...(REMINDER_CHOICES.filter((value) => value !== null) as number[]), extra].sort((a, b) => a - b)];
}

/** `<select>` values are strings: `none` stands for `null`. */
export function reminderOptionValue(minutes: number | null): string {
  return minutes === null ? 'none' : String(minutes);
}

export function reminderFromOptionValue(value: string): number | null {
  if (value === 'none') return null;
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 ? minutes : null;
}

export interface GoogleSettingsValues {
  readonly exportBlocks: boolean;
  readonly exportCommitments: boolean;
  readonly dailySummary: boolean;
  readonly reminderMinutes: number | null;
}

export interface GoogleCalendarChoice {
  readonly id: string;
  readonly selected: boolean;
}

/** What the screen edits: the import selection and the export settings. */
export interface GoogleSettingsDraft {
  /** Calendar ids ticked for import. */
  readonly selected: readonly string[];
  readonly settings: GoogleSettingsValues;
}

export function draftFrom(source: {
  readonly calendars: readonly GoogleCalendarChoice[];
  readonly settings: GoogleSettingsValues;
}): GoogleSettingsDraft {
  return {
    selected: source.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id),
    settings: { ...source.settings },
  };
}

/**
 * The PUT body: exactly the ticked calendars that the server listed (in its
 * order, each once) and the four settings. An id the server no longer lists
 * is dropped rather than sent (the server would answer 422).
 */
export function settingsPutBody(
  draft: GoogleSettingsDraft,
  calendars: readonly GoogleCalendarChoice[],
): { selectedCalendarIds: string[]; settings: GoogleSettingsValues } {
  const ticked = new Set(draft.selected);
  return {
    selectedCalendarIds: calendars.filter((calendar) => ticked.has(calendar.id)).map((calendar) => calendar.id),
    settings: {
      exportBlocks: draft.settings.exportBlocks,
      exportCommitments: draft.settings.exportCommitments,
      dailySummary: draft.settings.dailySummary,
      reminderMinutes: draft.settings.reminderMinutes,
    },
  };
}

export function sameDraft(left: GoogleSettingsDraft, right: GoogleSettingsDraft): boolean {
  const a = [...left.selected].sort();
  const b = [...right.selected].sort();
  return (
    a.length === b.length &&
    a.every((id, index) => id === b[index]) &&
    left.settings.exportBlocks === right.settings.exportBlocks &&
    left.settings.exportCommitments === right.settings.exportCommitments &&
    left.settings.dailySummary === right.settings.dailySummary &&
    left.settings.reminderMinutes === right.settings.reminderMinutes
  );
}

/** Calendars whose events the owner can only read at Google (a holiday or someone else's calendar). */
export function isReadOnlyCalendar(accessRole: string): boolean {
  return accessRole === 'reader' || accessRole === 'freeBusyReader';
}

/** The callback path on this app's origin, written as Google must have it (127.0.0.1, never localhost). */
export const GOOGLE_CALLBACK_PATH = '/api/v1/integrations/google/callback';

/** The guide's default web origin (`deploy/local/local.env` WEB_PORT 5180). */
export const DEFAULT_LOCAL_WEB_ORIGIN = 'http://127.0.0.1:5180';

/**
 * Where the app should be opened, from where it is open now: the same port on
 * 127.0.0.1 (a `localhost` session cookie does not survive Google's redirect).
 */
export function localWebOrigin(location: { readonly protocol: string; readonly hostname: string; readonly port: string } | null): string {
  if (location === null || (location.protocol !== 'http:' && location.protocol !== 'https:')) return DEFAULT_LOCAL_WEB_ORIGIN;
  const host = location.hostname === 'localhost' ? '127.0.0.1' : location.hostname;
  return `${location.protocol}//${host}${location.port === '' ? '' : `:${location.port}`}`;
}

/** The app is open on `localhost`, which the consent round trip cannot come back to. */
export function openedOnLocalhost(location: { readonly hostname: string } | null): boolean {
  return location?.hostname === 'localhost';
}

/** Literal setup facts from the user guide; shown as code, never translated. */
export const GOOGLE_SETUP = {
  guidePath: 'docs/user/Google-캘린더-연동-설정.md',
  consoleUrl: 'https://console.cloud.google.com/',
  scopes: [
    'https://www.googleapis.com/auth/calendar.app.created',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
  ],
  clientFile: 'deploy/secrets/local/google-oauth-client.json',
  placeCommands: [
    'mv ~/Downloads/client_secret_*.json deploy/secrets/local/google-oauth-client.json',
    'chmod 600 deploy/secrets/local/google-oauth-client.json',
  ],
  restartCommands: ['corepack pnpm local:secrets', 'corepack pnpm local:stop', 'corepack pnpm local:start'],
} as const;
