import { readonly, ref } from 'vue';
import { ko } from './messages/ko';
import {
  isPluralMessage,
  type At,
  type LocaleMessages,
  type MessageLeaf,
  type MessageTree,
  type ParamValue,
  type ParamsArg,
  type Placeholders,
  type PluralCategory,
  type PluralKeys,
  type PluralMessage,
  type PluralPlaceholders,
  type TextKeys,
} from './types';

/**
 * UI-I18N message layer.
 *
 * - Catalogs are bundled modules (no runtime fetch). Korean is the default and
 *   the key/placeholder contract; another locale is a `Messages` object added
 *   to `CATALOGS` plus its `Intl` locale in `INTL_LOCALES`.
 * - `t(key, params)` returns plain text. `tp(key, count, params)` picks a
 *   plural form through `Intl.PluralRules` (Korean always resolves to `other`).
 * - Both read the reactive `locale`, so templates re-render on a switch.
 */

type Ko = typeof ko;

export type Messages = LocaleMessages<Ko>;
export type MessageKey = TextKeys<Ko>;
export type PluralKey = PluralKeys<Ko>;
export type MessageParams<K extends MessageKey> = ParamsArg<Placeholders<At<Ko, K>>>;
export type PluralParams<K extends PluralKey> = ParamsArg<PluralPlaceholders<At<Ko, K>>>;
/** Keys whose message has no placeholders (safe to pick dynamically from a table). */
export type PlainKey = {
  [K in MessageKey]: [Placeholders<At<Ko, K>>] extends [never] ? K : never;
}[MessageKey];

const CATALOGS = { ko } satisfies Record<string, Messages>;

export type Locale = keyof typeof CATALOGS;

export const DEFAULT_LOCALE: Locale = 'ko';

/** BCP 47 tag used for every `Intl` formatter of a UI locale. */
export const INTL_LOCALES: Readonly<Record<Locale, string>> = { ko: 'ko-KR' };

const current = ref<Locale>(DEFAULT_LOCALE);

/** Reactive, read-only current locale. */
export const locale = readonly(current);

export function availableLocales(): Locale[] {
  return Object.keys(CATALOGS) as Locale[];
}

export function setLocale(next: Locale): void {
  current.value = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

export function intlLocale(): string {
  return INTL_LOCALES[current.value];
}

function catalogFor(target: Locale): MessageTree {
  return CATALOGS[target] as unknown as MessageTree;
}

function walk(tree: MessageTree, key: string): MessageLeaf | undefined {
  let node: MessageLeaf | MessageTree | undefined = tree;
  for (const segment of key.split('.')) {
    if (node === undefined || typeof node === 'string' || isPluralMessage(node)) return undefined;
    node = (node as MessageTree)[segment];
  }
  if (node === undefined) return undefined;
  if (typeof node === 'string' || isPluralMessage(node)) return node;
  return undefined;
}

/** Raw message for `key` in the current locale, falling back to the default. */
export function lookup(key: string): MessageLeaf | undefined {
  return walk(catalogFor(current.value), key) ?? walk(catalogFor(DEFAULT_LOCALE), key);
}

export function interpolate(template: string, params?: Readonly<Record<string, ParamValue>>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function t<K extends MessageKey>(key: K, ...args: MessageParams<K>): string {
  const message = lookup(key);
  if (typeof message !== 'string') return key;
  return interpolate(message, args[0] as Readonly<Record<string, ParamValue>> | undefined);
}

const pluralRules = new Map<string, Intl.PluralRules>();

function pluralCategory(count: number, tag: string): PluralCategory {
  let rules = pluralRules.get(tag);
  if (rules === undefined) {
    rules = new Intl.PluralRules(tag);
    pluralRules.set(tag, rules);
  }
  return rules.select(count) as PluralCategory;
}

/**
 * Plural form for `count` under the `Intl.PluralRules` of `tag`. An explicit
 * `zero` form wins for 0; a missing category falls back to `other`.
 */
export function selectPluralForm(forms: PluralMessage, count: number, tag: string = intlLocale()): string {
  if (count === 0 && forms.zero !== undefined) return forms.zero;
  return forms[pluralCategory(count, tag)] ?? forms.other;
}

export function tp<K extends PluralKey>(key: K, count: number, ...args: PluralParams<K>): string {
  const message = lookup(key);
  if (!isPluralMessage(message)) return key;
  const params = (args[0] ?? {}) as Readonly<Record<string, ParamValue>>;
  return interpolate(selectPluralForm(message, count), { ...params, count });
}

export { ko };
export { plural, isPluralMessage, PLURAL_BRAND, type PluralMessage } from './types';
