/**
 * What the app calls the signed-in user (HOLO-01). The account has no name
 * field, so it is the part of the e-mail address before the `@`; an address
 * without one is used whole. Never invented: no address, no name.
 */
export function displayNameOf(email: string | null | undefined): string {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/** The first character of the name, upper-cased, for the avatar tile. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? '' : first.toLocaleUpperCase('ko-KR');
}
