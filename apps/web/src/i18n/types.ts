/**
 * Type machinery for the message catalog (UI-I18N).
 *
 * The Korean catalog (`messages/ko.ts`) is the source of truth for keys and
 * placeholders. `MessageKey` / `PluralKey` are derived from it, so calling
 * `t()` with a key that does not exist, or without one of the `{placeholder}`
 * values the message needs, is a typecheck error. Any later locale is typed as
 * `Messages` (the same tree with plain `string` leaves), so a locale that
 * misses a key fails the typecheck too.
 */

/** Runtime brand that tells plural forms apart from nested message groups. */
export const PLURAL_BRAND: unique symbol = Symbol('ohmydate.i18n.plural');

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export type PluralForms = { readonly other: string } & {
  readonly [C in Exclude<PluralCategory, 'other'>]?: string;
};

/**
 * Plural message. Korean only ever uses `other`, but the shape follows
 * `Intl.PluralRules` categories so a locale such as English can add `one`.
 * `{count}` is always available as a placeholder.
 */
export type PluralMessage = PluralForms & { readonly [PLURAL_BRAND]: true };

export function plural<const T extends PluralForms>(forms: T): T & { readonly [PLURAL_BRAND]: true } {
  return { ...forms, [PLURAL_BRAND]: true as const };
}

export function isPluralMessage(value: unknown): value is PluralMessage {
  return typeof value === 'object' && value !== null && PLURAL_BRAND in value;
}

export type MessageLeaf = string | PluralMessage;

export interface MessageTree {
  readonly [key: string]: MessageLeaf | MessageTree;
}

/** Same tree as `T` with every leaf widened, i.e. the contract for another locale. */
export type LocaleMessages<T> = {
  readonly [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends PluralMessage
      ? PluralMessage
      : LocaleMessages<T[K]>;
};

type Join<P extends string, K extends string | number> = P extends '' ? `${K}` : `${P}.${K}`;

/** Keys usable in a dot path (numeric keys such as weekday `1` included). */
type PathKey<T> = keyof T & (string | number);

/** Dot paths of every plain-string message. */
export type TextKeys<T, P extends string = ''> = {
  [K in PathKey<T>]: T[K] extends string
    ? Join<P, K>
    : T[K] extends PluralMessage
      ? never
      : TextKeys<T[K], Join<P, K>>;
}[PathKey<T>];

/** Dot paths of every plural message. */
export type PluralKeys<T, P extends string = ''> = {
  [K in PathKey<T>]: T[K] extends string
    ? never
    : T[K] extends PluralMessage
      ? Join<P, K>
      : PluralKeys<T[K], Join<P, K>>;
}[PathKey<T>];

type Prop<T, K extends string> = K extends keyof T
  ? T[K]
  : K extends `${infer N extends number}`
    ? N extends keyof T
      ? T[N]
      : never
    : never;

/** Value at a dot path. */
export type At<T, K extends string> = K extends `${infer Head}.${infer Rest}`
  ? At<Prop<T, Head>, Rest>
  : Prop<T, K>;

/** `{name}` placeholders of a literal message string. */
export type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

type FormKeys = PluralCategory;

/** Placeholders of every plural form except the implicit `{count}`. */
export type PluralPlaceholders<M> = Exclude<
  { [F in FormKeys & keyof M]: Placeholders<M[F]> }[FormKeys & keyof M],
  'count'
>;

export type ParamValue = string | number;

/** No argument when a message has no placeholders, otherwise a typed record. */
export type ParamsArg<Names extends string> = [Names] extends [never]
  ? []
  : [params: Record<Names, ParamValue>];
