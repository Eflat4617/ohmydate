/**
 * What the app calls the signed-in user (HOLO-01). The account has no name
 * field, so it is the part of the e-mail address before the `@`; an address
 * without one is used whole. Never invented: no address, no name. Since
 * HOLO-07 the owner can choose a name instead (`displayNameFor`, below).
 */
export function displayNameOf(email: string | null | undefined): string {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/** The longest name the owner may choose, in characters as a person counts them (code points). */
export const CHOSEN_NAME_MAX = 30;

/**
 * A name the owner typed for themselves (HOLO-07), made fit to keep: control
 * characters dropped, every run of white space one space, none at the ends,
 * and at most `CHOSEN_NAME_MAX` characters — a longer one is cut there, not
 * refused. Anything that is not text, or that is empty once cleaned, is no
 * name (`''`). It is plain text and is only ever shown as text.
 */
export function cleanChosenName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const spaced = raw
    .replace(/\s+/gu, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  return [...spaced].slice(0, CHOSEN_NAME_MAX).join('').trim();
}

/**
 * What the app calls the owner: the name they chose on this device, else the
 * part of their e-mail address before the `@`, else nothing.
 */
export function displayNameFor(chosen: string, email: string | null | undefined): string {
  return chosen.length > 0 ? chosen : displayNameOf(email);
}

/** The first character of the name, upper-cased, for the avatar tile. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? '' : first.toLocaleUpperCase('ko-KR');
}
