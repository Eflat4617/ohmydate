/**
 * FU-89: the language every user-facing string of an intake LLM call (and of
 * the manual fallback draft) is written in, as the structured `outputLanguage`
 * input of type_detection@v2 and decomposition@v3/v4.
 *
 * It comes from the owner's `locale` setting, never from intake text. The
 * setting is a free string (contracts: 2..35 characters, not validated as
 * BCP-47), so it is reduced to `language[-Script][-REGION]` of a well-formed
 * tag whose language is known to ICU. Extensions and private-use subtags are
 * dropped, so the value can never carry free text into the prompt.
 *
 * Fallback: `ko-KR` when the locale is missing, malformed or names no known
 * language (GU-1 is a Korean-UI try-out and the web UI ships Korean only). A
 * valid locale such as `en` is honoured as is.
 */

declare const outputLanguageBrand: unique symbol;

/** A normalized BCP-47 tag; only `resolveOutputLanguage` produces one. */
export type OutputLanguage = string & { readonly [outputLanguageBrand]: true };

export const FALLBACK_OUTPUT_LANGUAGE = 'ko-KR' as OutputLanguage;

/** What a resolved tag can look like: `ko`, `ko-KR`, `zh-Hant-TW`, `es-419`. */
export const OUTPUT_LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

const MAX_LOCALE_LENGTH = 35;
/** Codes that are well formed but name no language to write in. */
const NOT_A_LANGUAGE: ReadonlySet<string> = new Set(['und', 'zxx', 'mul', 'mis']);
const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** The owner's locale as an output language; never throws. */
export function resolveOutputLanguage(locale: unknown): OutputLanguage {
  if (typeof locale !== 'string') return FALLBACK_OUTPUT_LANGUAGE;
  const trimmed = locale.trim();
  if (trimmed.length < 2 || trimmed.length > MAX_LOCALE_LENGTH) return FALLBACK_OUTPUT_LANGUAGE;
  try {
    // `ko_KR` (POSIX style) is accepted as `ko-KR`.
    const [canonical] = Intl.getCanonicalLocales(trimmed.replaceAll('_', '-'));
    if (canonical === undefined) return FALLBACK_OUTPUT_LANGUAGE;
    const parsed = new Intl.Locale(canonical);
    // `und` parses with no language at all (Node 24 / ICU 77).
    const language: string | undefined = parsed.language;
    if (language === undefined || language.length === 0 || NOT_A_LANGUAGE.has(language)) {
      return FALLBACK_OUTPUT_LANGUAGE;
    }
    if (languageNames.of(language) === undefined) return FALLBACK_OUTPUT_LANGUAGE;
    const tag = [language, parsed.script, parsed.region].filter((part) => part !== undefined).join('-');
    return OUTPUT_LANGUAGE_PATTERN.test(tag) ? (tag as OutputLanguage) : FALLBACK_OUTPUT_LANGUAGE;
  } catch {
    // Malformed tags (RangeError) and any ICU surprise: never fail the intake.
    return FALLBACK_OUTPUT_LANGUAGE;
  }
}

/** Primary language subtag, e.g. `ko` for `ko-KR`. */
export function primaryLanguage(language: OutputLanguage): string {
  return language.split('-')[0] as string;
}
