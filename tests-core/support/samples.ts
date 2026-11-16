/**
 * Sample values for the schema comparison (blueprint 15 §11 R13).
 *
 * For a JSON schema of the contract this builds one valid instance and then
 * many variants of it, each changing one place: a value at the edge of a
 * length or a bound, of another type, in every spelling of a format that
 * validators are known to disagree about, with characters that count
 * differently in different runtimes, with a property missing or added.
 *
 * A sample is JSON *text*, not a value, so that spellings a JavaScript value
 * cannot hold survive the trip to the other validator: `1.0`, `1e400`, a
 * repeated key, a lone surrogate.
 *
 * Nothing here says whether a sample is valid. The two validators say; the
 * tool lists where they differ.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The JSON Schema keywords the contract uses (a survey is asserted by the tool). */
export interface Schema {
  readonly type?: string;
  readonly const?: Json;
  readonly anyOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly minProperties?: number;
  readonly items?: Schema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly format?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export const KNOWN_KEYWORDS: readonly string[] = [
  'type', 'const', 'anyOf', 'properties', 'required', 'additionalProperties', 'minProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'format', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum',
  // Annotations: they do not change a verdict.
  'description', '$id', 'title', 'default',
];

export interface Sample {
  /** What was changed, without where: samples of one kind are judged alike. */
  readonly kind: string;
  /** JSON pointer of the changed place (`/` is the whole value). */
  readonly pointer: string;
  /** The sample as JSON text. */
  readonly text: string;
}

const UUID7 = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const ASTRAL = '😀'; // one code point, two UTF-16 units
const COMBINING = String.fromCodePoint(0x65, 0x301); // two code points, one visible character

type Table = Readonly<Record<string, string>>;

const DATE_TIME: Table = {
  'utc-z': '2026-11-16T09:30:00Z',
  'fraction-1': '2026-11-16T09:30:00.1Z',
  'fraction-3': '2026-11-16T09:30:00.123Z',
  'fraction-9': '2026-11-16T09:30:00.123456789Z',
  'fraction-12': '2026-11-16T09:30:00.123456789012Z',
  'fraction-empty': '2026-11-16T09:30:00.Z',
  'fraction-comma': '2026-11-16T09:30:00,123Z',
  'offset-plus': '2026-11-16T18:30:00+09:00',
  'offset-minus': '2026-11-16T04:30:00-05:00',
  'offset-zero': '2026-11-16T09:30:00+00:00',
  'offset-minus-zero': '2026-11-16T09:30:00-00:00',
  'offset-no-colon': '2026-11-16T18:30:00+0900',
  'offset-hours-only': '2026-11-16T18:30:00+09',
  'offset-hour-24': '2026-11-16T18:30:00+24:00',
  'offset-minute-60': '2026-11-16T18:30:00+09:60',
  'offset-seconds': '2026-11-16T18:30:00+09:00:00',
  'lowercase-t': '2026-11-16t09:30:00Z',
  'lowercase-z': '2026-11-16T09:30:00z',
  'space-separator': '2026-11-16 09:30:00Z',
  'no-separator': '2026-11-1609:30:00Z',
  'no-offset': '2026-11-16T09:30:00',
  'no-seconds': '2026-11-16T09:30Z',
  'date-only': '2026-11-16',
  'time-only': '09:30:00Z',
  'hour-24': '2026-11-16T24:00:00Z',
  'minute-60': '2026-11-16T09:60:00Z',
  'leap-second': '2026-12-31T23:59:60Z',
  'leap-second-offset': '2026-12-31T15:59:60-08:00',
  'second-60-midday': '2026-11-16T09:30:60Z',
  'second-61': '2026-12-31T23:59:61Z',
  'month-00': '2026-00-16T09:30:00Z',
  'month-13': '2026-13-16T09:30:00Z',
  'day-00': '2026-11-00T09:30:00Z',
  'day-32': '2026-11-32T09:30:00Z',
  'nov-31': '2026-11-31T09:30:00Z',
  'feb-30': '2026-02-30T09:30:00Z',
  'feb-29-leap': '2028-02-29T09:30:00Z',
  'feb-29-common': '2026-02-29T09:30:00Z',
  'feb-29-1900': '1900-02-29T09:30:00Z',
  'feb-29-2000': '2000-02-29T09:30:00Z',
  'year-0000': '0000-01-01T00:00:00Z',
  'year-9999': '9999-12-31T23:59:59Z',
  'year-5-digits': '10000-01-01T00:00:00Z',
  'year-2-digits': '26-11-16T09:30:00Z',
  'year-negative': '-2026-11-16T09:30:00Z',
  'leading-space': ' 2026-11-16T09:30:00Z',
  'trailing-space': '2026-11-16T09:30:00Z ',
  'trailing-newline': '2026-11-16T09:30:00Z\n',
  'fullwidth-digits': '２０２６-11-16T09:30:00Z',
  'arabic-digits': '٢٠٢٦-11-16T09:30:00Z',
  'basic-format': '20261116T093000Z',
  'ordinal-date': '2026-320T09:30:00Z',
  'week-date': '2026-W47-1T09:30:00Z',
  'rfc-2822': 'Mon, 16 Nov 2026 09:30:00 GMT',
  'epoch-digits': '1794821400000',
  empty: '',
};

const DATE: Table = {
  plain: '2026-11-16',
  'feb-29-leap': '2028-02-29',
  'feb-29-common': '2026-02-29',
  'feb-29-1900': '1900-02-29',
  'feb-30': '2026-02-30',
  'apr-31': '2026-04-31',
  'month-00': '2026-00-10',
  'month-13': '2026-13-10',
  'day-00': '2026-11-00',
  'day-32': '2026-11-32',
  'year-0000': '0000-01-01',
  'year-9999': '9999-12-31',
  'year-5-digits': '12026-11-16',
  'year-negative': '-2026-11-16',
  'short-month': '2026-1-16',
  'short-day': '2026-11-6',
  slashes: '2026/11/16',
  'basic-format': '20261116',
  'with-time': '2026-11-16T00:00:00Z',
  'fullwidth-digits': '２０２６-11-16',
  'arabic-digits': '٢٠٢٦-١١-١٦',
  'leading-space': ' 2026-11-16',
  'trailing-space': '2026-11-16 ',
  'trailing-newline': '2026-11-16\n',
  empty: '',
};

const UUID: Table = {
  'v7-lower': UUID7,
  'v7-upper': UUID7.toUpperCase(),
  'v7-mixed-case': '0193A8f2-6c1e-7B41-9a2e-1f1d6a0b3c55',
  v4: '0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c55',
  v1: '0193a8f2-6c1e-1b41-9a2e-1f1d6a0b3c55',
  v8: '0193a8f2-6c1e-8b41-9a2e-1f1d6a0b3c55',
  'variant-c': '0193a8f2-6c1e-7b41-ca2e-1f1d6a0b3c55',
  'variant-0': '0193a8f2-6c1e-7b41-0a2e-1f1d6a0b3c55',
  nil: '00000000-0000-0000-0000-000000000000',
  max: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  'urn-prefix': `urn:uuid:${UUID7}`,
  'urn-prefix-upper': `URN:UUID:${UUID7}`,
  braces: `{${UUID7}}`,
  'no-dashes': UUID7.replace(/-/g, ''),
  'dashes-moved': '0193a8f26-c1e-7b41-9a2e-1f1d6a0b3c55',
  short: UUID7.slice(0, 35),
  long: `${UUID7}5`,
  'non-hex': '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c5g',
  'fullwidth-digit': '０193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55',
  'leading-space': ` ${UUID7}`,
  'trailing-space': `${UUID7} `,
  'trailing-newline': `${UUID7}\n`,
  empty: '',
};

const EMAIL: Table = {
  simple: 'owner@example.com',
  plus: 'owner+planner@example.com',
  subdomain: 'owner@mail.example.co.kr',
  uppercase: 'Owner@Example.COM',
  'no-tld': 'owner@localhost',
  'ip-literal': 'owner@[127.0.0.1]',
  'quoted-local': '"an owner"@example.com',
  'unicode-local': '사용자@example.com',
  'idn-domain': 'owner@예시.kr',
  punycode: 'owner@xn--9n2bp8q.kr',
  'trailing-dot': 'owner@example.com.',
  'double-dot-local': 'own..er@example.com',
  'leading-dot': '.owner@example.com',
  'dot-before-at': 'owner.@example.com',
  'hyphen-label-start': 'owner@-example.com',
  'no-at': 'owner.example.com',
  'two-at': 'owner@example@example.com',
  space: 'own er@example.com',
  'long-local': `${'a'.repeat(65)}@example.com`,
  'long-label': `owner@${'a'.repeat(64)}.com`,
  angle: '<owner@example.com>',
  'display-name': 'Owner <owner@example.com>',
  'leading-space': ' owner@example.com',
  'trailing-space': 'owner@example.com ',
  'trailing-newline': 'owner@example.com\n',
  empty: '',
};

const IANA_TIME_ZONE: Table = {
  canonical: 'Asia/Seoul',
  utc: 'UTC',
  'etc-utc': 'Etc/UTC',
  'three-parts': 'America/Argentina/Buenos_Aires',
  hyphen: 'America/Port-au-Prince',
  'renamed-old-calcutta': 'Asia/Calcutta',
  'renamed-new-kolkata': 'Asia/Kolkata',
  'renamed-old-kiev': 'Europe/Kiev',
  'renamed-new-kyiv': 'Europe/Kyiv',
  'renamed-old-saigon': 'Asia/Saigon',
  'renamed-new-ho-chi-minh': 'Asia/Ho_Chi_Minh',
  'renamed-old-godthab': 'America/Godthab',
  'renamed-new-nuuk': 'America/Nuuk',
  'renamed-old-enderbury': 'Pacific/Enderbury',
  'renamed-new-kanton': 'Pacific/Kanton',
  'recent-ciudad-juarez': 'America/Ciudad_Juarez',
  'link-us': 'US/Pacific',
  'link-country': 'Japan',
  'link-rok': 'ROK',
  'link-gmt': 'GMT',
  'link-uct': 'UCT',
  'link-zulu': 'Zulu',
  'link-universal': 'Universal',
  'etc-gmt': 'Etc/GMT',
  'etc-gmt-offset': 'Etc/GMT+9',
  'etc-zulu': 'Etc/Zulu',
  'legacy-est': 'EST',
  'legacy-est5edt': 'EST5EDT',
  'legacy-cet': 'CET',
  'posix-prefix': 'posix/Asia/Seoul',
  'right-prefix': 'right/Asia/Seoul',
  factory: 'Factory',
  localtime: 'localtime',
  lowercase: 'asia/seoul',
  uppercase: 'ASIA/SEOUL',
  'utc-lowercase': 'utc',
  'numeric-offset': '+09:00',
  'utc-plus': 'UTC+9',
  'gmt-plus': 'GMT+9',
  z: 'Z',
  abbreviation: 'KST',
  unknown: 'Mars/Olympus_Mons',
  'city-only': 'Seoul',
  'area-only': 'Asia',
  'trailing-slash': 'Asia/Seoul/',
  traversal: '../etc/passwd',
  'leading-space': ' Asia/Seoul',
  'trailing-space': 'Asia/Seoul ',
  'trailing-newline': 'Asia/Seoul\n',
  empty: '',
};

const URI: Table = {
  https: 'https://example.com/callback',
  http: 'http://example.com/callback',
  'port-query-fragment': 'https://example.com:8443/callback?state=1#done',
  'ip-v4': 'https://127.0.0.1:8443/callback',
  'ip-v6': 'https://[::1]:8443/callback',
  userinfo: 'https://user:secret@example.com/callback',
  'uppercase-scheme': 'HTTPS://EXAMPLE.COM/callback',
  'percent-encoded': 'https://example.com/%EA%B2%BD%EB%A1%9C',
  'bad-percent': 'https://example.com/%zz',
  'unicode-path': 'https://example.com/경로',
  'unicode-host': 'https://예시.kr/callback',
  space: 'https://example.com/a b',
  backslash: 'https://example.com\\callback',
  tab: 'https://example.com/a\tb',
  'no-host': 'https:///callback',
  'scheme-only': 'https:',
  'no-scheme': 'example.com/callback',
  relative: '/callback',
  'protocol-relative': '//example.com/callback',
  mailto: 'mailto:owner@example.com',
  urn: 'urn:isbn:0451450523',
  javascript: 'javascript:alert(1)',
  'leading-space': ' https://example.com/callback',
  'trailing-newline': 'https://example.com/callback\n',
  empty: '',
};

const FORMATS: Readonly<Record<string, { readonly valid: string; readonly samples: Table }>> = {
  'date-time': { valid: '2026-11-16T09:30:00.000Z', samples: DATE_TIME },
  date: { valid: '2026-11-16', samples: DATE },
  uuid: { valid: UUID7, samples: UUID },
  email: { valid: 'owner@example.com', samples: EMAIL },
  'iana-time-zone': { valid: 'Asia/Seoul', samples: IANA_TIME_ZONE },
  uri: { valid: 'https://example.com/callback', samples: URI },
};

const CLOCK_SAMPLES: Table = {
  midnight: '00:00',
  morning: '09:30',
  'last-minute': '23:59',
  'end-of-day': '24:00',
  'after-end-of-day': '24:01',
  'hour-25': '25:00',
  'minute-60': '09:60',
  'one-digit-hour': '9:30',
  seconds: '09:30:00',
  'fullwidth-digits': '０９:３０',
  'arabic-digits': '٠٩:٣٠',
  'trailing-newline': '09:30\n',
  'leading-newline': '\n09:30',
  'trailing-space': '09:30 ',
  empty: '',
};

const VERSION_TAG_SAMPLES: Table = {
  one: 'W/"1"',
  'u32-max': 'W/"4294967295"',
  'u32-overflow': 'W/"4294967296"',
  huge: 'W/"99999999999999999999"',
  zero: 'W/"0"',
  'leading-zero': 'W/"01"',
  negative: 'W/"-1"',
  strong: '"1"',
  bare: '1',
  'lowercase-w': 'w/"1"',
  star: '*',
  list: 'W/"1", W/"2"',
  'fullwidth-digit': 'W/"１"',
  'empty-tag': 'W/""',
  'availability-tag': 'W/"availability:1"',
  empty: '',
};

const AVAILABILITY_TAG_SAMPLES: Table = {
  one: 'W/"availability:1"',
  'u32-max': 'W/"availability:4294967295"',
  'u32-overflow': 'W/"availability:4294967296"',
  zero: 'W/"availability:0"',
  'leading-zero': 'W/"availability:01"',
  'version-tag': 'W/"1"',
  capitalised: 'W/"Availability:1"',
  strong: '"availability:1"',
  'fullwidth-digit': 'W/"availability:１"',
  empty: '',
};

/** Every `pattern` of the contract: a value that satisfies it, and near misses. */
const PATTERNS: Readonly<Record<string, { readonly name: string; readonly valid: string; readonly samples: Table }>> = {
  '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$': { name: 'clock-or-24', valid: '18:00', samples: CLOCK_SAMPLES },
  '^([01][0-9]|2[0-3]):[0-5][0-9]$': { name: 'clock', valid: '09:30', samples: CLOCK_SAMPLES },
  '^W/"[1-9][0-9]*"$': { name: 'version-tag', valid: 'W/"1"', samples: VERSION_TAG_SAMPLES },
  '^W/"availability:[1-9][0-9]*"$': {
    name: 'availability-tag',
    valid: 'W/"availability:1"',
    samples: AVAILABILITY_TAG_SAMPLES,
  },
  '^FREQ=': {
    name: 'rrule',
    valid: 'FREQ=WEEKLY;BYDAY=MO',
    samples: {
      weekly: 'FREQ=WEEKLY;BYDAY=MO',
      'name-only': 'FREQ=',
      lowercase: 'freq=WEEKLY',
      'rrule-prefix': 'RRULE:FREQ=WEEKLY',
      'leading-space': ' FREQ=WEEKLY',
      'second-line': 'X\nFREQ=WEEKLY',
      empty: '',
    },
  },
  '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$': {
    name: 'uuid-v7',
    valid: UUID7,
    samples: UUID,
  },
  '^s[0-9]{1,2}$': {
    name: 'step-key',
    valid: 's1',
    samples: {
      one: 's1',
      two: 's12',
      three: 's123',
      none: 's',
      uppercase: 'S1',
      letter: 'sA',
      negative: 's-1',
      'fullwidth-digit': 's１',
      'trailing-newline': 's1\n',
      empty: '',
    },
  },
  '^https://': { name: 'https', valid: 'https://example.com/callback', samples: URI },
  '^[A-Za-z0-9_-]+=*$': {
    name: 'base64url',
    valid: 'abc123',
    samples: {
      plain: 'abc123',
      padded: 'abc=',
      'only-padding': '=',
      'standard-alphabet': 'ab+/',
      space: 'ab c',
      hangul: '한글',
      'trailing-newline': 'abc\n',
      empty: '',
    },
  },
  '\\S': { name: 'non-blank', valid: 'a', samples: {} },
};

/**
 * Characters that are "blank", "one character" or "text at all" in one
 * runtime and not in another. Used for strings that are free text.
 */
const TEXT: Readonly<Record<string, string>> = {
  empty: '""',
  space: '" "',
  tab: '"\\t"',
  newline: '"\\n"',
  'vertical-tab': '"\\u000b"',
  'no-break-space': '"\\u00a0"',
  'next-line': '"\\u0085"',
  'byte-order-mark': '"\\ufeff"',
  'ideographic-space': '"\\u3000"',
  'line-separator': '"\\u2028"',
  'zero-width-space': '"\\u200b"',
  'mongolian-vowel-separator': '"\\u180e"',
  nul: '"\\u0000"',
  'nul-inside': '"a\\u0000b"',
  // A UTF-16 half without its other half: text to JavaScript, not Unicode.
  'lone-surrogate': '"\\ud800"',
  'lone-surrogate-inside': '"a\\udc00b"',
  'surrogate-pair-escaped': '"\\ud83d\\ude00"',
  astral: JSON.stringify(ASTRAL),
  combining: JSON.stringify(COMBINING),
  'right-to-left': JSON.stringify('مرحبا'),
  'zwj-sequence': JSON.stringify('👨‍👩‍👧'),
  hangul: JSON.stringify('논문 읽기'),
};

function pointerOf(path: readonly (string | number)[]): string {
  return path.length === 0
    ? '/'
    : `/${path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function nonNull(alternatives: readonly Schema[]): readonly Schema[] {
  return alternatives.filter((alternative) => alternative.type !== 'null');
}

function validString(schema: Schema): string {
  if (schema.format !== undefined) {
    const known = FORMATS[schema.format];
    if (known === undefined) throw new Error(`the sample generator does not know the format ${schema.format}`);
    return known.valid;
  }
  const length = Math.min(Math.max(schema.minLength ?? 1, 1), schema.maxLength ?? Number.MAX_SAFE_INTEGER);
  if (schema.pattern !== undefined) {
    const known = PATTERNS[schema.pattern];
    if (known === undefined) throw new Error(`the sample generator does not know the pattern ${schema.pattern}`);
    if (known.name === 'base64url') return known.valid.padEnd(length, 'A');
    if (known.name !== 'non-blank') return known.valid;
  }
  return 'a'.repeat(length);
}

/** A distinct valid value for the `index`-th item of a `uniqueItems` array. */
function variantOf(schema: Schema, index: number): Json {
  if (schema.anyOf !== undefined) {
    const alternatives = nonNull(schema.anyOf);
    return validOf(alternatives[index % alternatives.length] ?? {});
  }
  const value = validOf(schema);
  if (typeof value !== 'string' || index === 0) return value;
  // Ids differ in their last digits; free text gets a suffix.
  return schema.format === 'uuid' || schema.pattern !== undefined
    ? value.slice(0, -2) + index.toString(16).padStart(2, '0')
    : `${value}${index}`;
}

/** One instance the schema accepts. */
export function validOf(schema: Schema): Json {
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf !== undefined) return validOf(nonNull(schema.anyOf)[0] ?? { type: 'null' });
  switch (schema.type) {
    case 'string':
      return validString(schema);
    case 'integer':
    case 'number': {
      const wanted = schema.minimum ?? 1;
      return schema.maximum !== undefined && wanted > schema.maximum ? schema.maximum : wanted;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array': {
      const count = Math.min(Math.max(schema.minItems ?? 1, 1), schema.maxItems ?? Number.MAX_SAFE_INTEGER);
      return Array.from({ length: count }, (_, index) => variantOf(schema.items ?? {}, index));
    }
    case 'object': {
      const value: { [key: string]: Json } = {};
      for (const [name, property] of Object.entries(schema.properties ?? {})) value[name] = validOf(property);
      return value;
    }
    default:
      throw new Error(`the sample generator does not know the schema ${JSON.stringify(schema).slice(0, 120)}`);
  }
}

/** One change: the value at `path` becomes the JSON text `text`. */
interface Change {
  readonly kind: string;
  readonly path: readonly (string | number)[];
  readonly text: string;
}

const json = (value: Json): string => JSON.stringify(value);

function typeName(schema: Schema): string {
  if (schema.const !== undefined || schema.anyOf?.every((alternative) => alternative.const !== undefined) === true) {
    return 'enum';
  }
  if (schema.anyOf !== undefined) return 'union';
  return schema.type ?? 'any';
}

function* stringChanges(schema: Schema, path: Change['path']): Generator<Change> {
  const filler = (length: number, unit = 'a'): string => json(unit.repeat(Math.max(length, 0)));
  if (schema.minLength !== undefined && schema.minLength > 0) {
    yield { kind: 'length:min-1', path, text: filler(schema.minLength - 1) };
    yield { kind: 'length:min', path, text: filler(schema.minLength) };
  }
  if (schema.maxLength !== undefined) {
    yield { kind: 'length:max', path, text: filler(schema.maxLength) };
    yield { kind: 'length:max+1', path, text: filler(schema.maxLength + 1) };
    // Lengths count characters (code points), not UTF-16 units and not bytes.
    yield { kind: 'length:max-astral', path, text: filler(schema.maxLength, ASTRAL) };
    yield { kind: 'length:max+1-astral', path, text: filler(schema.maxLength + 1, ASTRAL) };
    yield { kind: 'length:max-half-astral', path, text: filler(Math.ceil((schema.maxLength + 1) / 2), ASTRAL) };
    yield { kind: 'length:max-combining', path, text: filler(Math.floor(schema.maxLength / 2), COMBINING) };
    yield { kind: 'length:max+1-combining', path, text: filler(Math.floor(schema.maxLength / 2) + 1, COMBINING) };
  }
  if (schema.format !== undefined) {
    for (const [name, value] of Object.entries(FORMATS[schema.format]?.samples ?? {})) {
      yield { kind: `format:${schema.format}:${name}`, path, text: json(value) };
    }
  }
  const pattern = schema.pattern === undefined ? undefined : PATTERNS[schema.pattern];
  if (pattern !== undefined && !(schema.format === 'uuid' && pattern.name === 'uuid-v7')) {
    for (const [name, value] of Object.entries(pattern.samples)) {
      yield { kind: `pattern:${pattern.name}:${name}`, path, text: json(value) };
    }
  }
  if (schema.format === undefined && (pattern === undefined || pattern.name === 'non-blank')) {
    const family = pattern === undefined ? 'text' : 'non-blank-text';
    for (const [name, text] of Object.entries(TEXT)) yield { kind: `${family}:${name}`, path, text };
  }
}

function* numberChanges(schema: Schema, path: Change['path'], value: number): Generator<Change> {
  const family = schema.type === 'integer' ? 'integer' : 'number';
  if (schema.minimum !== undefined) {
    yield { kind: `${family}:min`, path, text: String(schema.minimum) };
    yield { kind: `${family}:min-1`, path, text: String(schema.minimum - 1) };
    yield { kind: `${family}:just-below-min`, path, text: String(schema.minimum - 1e-9) };
  }
  if (schema.maximum !== undefined) {
    yield { kind: `${family}:max`, path, text: String(schema.maximum) };
    yield { kind: `${family}:max+1`, path, text: String(schema.maximum + 1) };
    yield { kind: `${family}:just-above-max`, path, text: `${schema.maximum}.000000001` };
  }
  yield { kind: `${family}:fraction`, path, text: `${value}.5` };
  // The same number written in ways a JavaScript value cannot keep apart.
  yield { kind: `${family}:written-as-float`, path, text: `${value}.0` };
  yield { kind: `${family}:written-with-exponent`, path, text: `${value}e0` };
  yield { kind: `${family}:written-with-capital-exponent`, path, text: `${value}E+0` };
  yield { kind: `${family}:rounds-to-itself`, path, text: `${value}.00000000000000000000001` };
  yield { kind: `${family}:negative-zero`, path, text: '-0' };
  yield { kind: `${family}:beyond-f64`, path, text: '1e400' };
  yield { kind: `${family}:below-f64`, path, text: '1e-400' };
  yield { kind: `${family}:two-to-the-53-plus-1`, path, text: '9007199254740993' };
  yield { kind: `${family}:two-to-the-64`, path, text: '18446744073709551616' };
  yield { kind: `${family}:digits-as-text`, path, text: json(String(value)) };
  yield { kind: `${family}:leading-zero`, path, text: `0${value}` };
  yield { kind: `${family}:leading-plus`, path, text: `+${value}` };
  yield { kind: `${family}:hexadecimal`, path, text: '0x10' };
  yield { kind: `${family}:nan`, path, text: 'NaN' };
  yield { kind: `${family}:infinity`, path, text: 'Infinity' };
}

/** Values of every JSON type, to put where another type belongs. */
const OTHER_TYPES: Readonly<Record<string, string>> = {
  null: 'null',
  true: 'true',
  false: 'false',
  zero: '0',
  one: '1',
  fraction: '1.5',
  'empty-string': '""',
  string: '"text"',
  'empty-array': '[]',
  array: '["text"]',
  'empty-object': '{}',
  object: '{"key":"value"}',
};

function* changesAt(schema: Schema, value: Json, path: Change['path']): Generator<Change> {
  const expected = typeName(schema);
  for (const [name, text] of Object.entries(OTHER_TYPES)) {
    yield { kind: `type:${expected}:${name}`, path, text };
  }

  if (schema.const !== undefined || schema.anyOf !== undefined) {
    const alternatives = schema.anyOf ?? [schema];
    const constants = alternatives.filter((alternative) => alternative.const !== undefined);
    for (const alternative of constants) yield { kind: 'enum:member', path, text: json(alternative.const ?? null) };
    const first = constants.find((alternative) => typeof alternative.const === 'string')?.const;
    if (typeof first === 'string') {
      yield { kind: 'enum:unknown', path, text: json('no-such-member') };
      yield { kind: 'enum:uppercase', path, text: json(first.toUpperCase()) };
      yield { kind: 'enum:capitalised', path, text: json(first.charAt(0).toUpperCase() + first.slice(1)) };
      yield { kind: 'enum:trailing-space', path, text: json(`${first} `) };
      yield { kind: 'enum:prefix', path, text: json(first.slice(0, -1)) };
      yield { kind: 'enum:empty', path, text: json('') };
    }
    // Alternatives that are not constants (a nullable field) are walked as
    // what they are.
    for (const alternative of alternatives) {
      if (alternative.const === undefined && alternative.type !== 'null') {
        yield* changesAt(alternative, value, path);
      }
    }
    return;
  }

  if (schema.type === 'string') yield* stringChanges(schema, path);
  if ((schema.type === 'integer' || schema.type === 'number') && typeof value === 'number') {
    yield* numberChanges(schema, path, value);
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    const items = schema.items ?? {};
    const many = (count: number): string =>
      json(Array.from({ length: Math.max(count, 0) }, (_, index) => variantOf(items, index)));
    yield { kind: 'array:empty', path, text: '[]' };
    if (schema.minItems !== undefined && schema.minItems > 0) {
      yield { kind: 'array:min-1', path, text: many(schema.minItems - 1) };
      yield { kind: 'array:min', path, text: many(schema.minItems) };
    }
    if (schema.maxItems !== undefined) {
      yield { kind: 'array:max', path, text: many(schema.maxItems) };
      yield { kind: 'array:max+1', path, text: many(schema.maxItems + 1) };
    }
    const first = variantOf(items, 0);
    yield {
      kind: schema.uniqueItems === true ? 'array:duplicate-unique' : 'array:duplicate',
      path,
      text: json([first, first]),
    };
    if (value.length > 0) yield* changesAt(items, value[0] ?? null, [...path, 0]);
  }

  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const inner = json(value).slice(1, -1);
    const withRawMember = (member: string): string => `{${member}${inner === '' ? '' : `,${inner}`}}`;
    const closed = schema.additionalProperties === false ? 'closed' : 'open';
    yield { kind: `object:${closed}:unknown-property`, path, text: json({ ...value, unexpectedField: true }) };
    // Names that exist on every JavaScript object.
    yield { kind: `object:${closed}:proto-key`, path, text: withRawMember('"__proto__":{"polluted":true}') };
    yield { kind: `object:${closed}:constructor-key`, path, text: withRawMember('"constructor":1') };
    yield { kind: `object:${closed}:to-string-key`, path, text: withRawMember('"toString":1') };
    yield { kind: `object:${closed}:empty-key`, path, text: withRawMember('"":1') };
    yield { kind: 'object:empty', path, text: '{}' };
    for (const name of schema.required ?? []) {
      const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== name));
      yield { kind: 'object:missing-required', path, text: json(rest) };
      yield { kind: 'object:required-is-null', path, text: json({ ...value, [name]: null }) };
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      const current = value[name];
      if (current === undefined) continue;
      if (!(schema.required ?? []).includes(name)) {
        const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== name));
        yield { kind: 'object:optional-absent', path, text: json(rest) };
      }
      // The same key twice: which one counts?
      yield {
        kind: 'object:key-twice-last-wrong',
        path,
        text: `{${inner},${json(name)}:{"not":"this"}}`,
      };
      yield {
        kind: 'object:key-twice-first-wrong',
        path,
        text: `{${json(name)}:{"not":"this"},${inner}}`,
      };
      yield* changesAt(property, current, [...path, name]);
    }
  }
}

const SENTINEL = '@@changed-here@@';

function replaceAt(base: Json, path: readonly (string | number)[]): Json {
  if (path.length === 0) return SENTINEL;
  const [head, ...rest] = path;
  if (Array.isArray(base) && typeof head === 'number') {
    return base.map((item, index) => (index === head ? replaceAt(item, rest) : item));
  }
  if (base !== null && typeof base === 'object' && !Array.isArray(base) && typeof head === 'string') {
    return Object.fromEntries(
      Object.entries(base).map(([key, item]) => [key, key === head ? replaceAt(item, rest) : item]),
    );
  }
  throw new Error(`no value at ${pointerOf(path)}`);
}

/**
 * The valid instance (`kind: 'base'`) and every variant of it. `only`
 * filters by kind and text (header values are strings, for example).
 */
export function samplesOf(schema: Schema, only: (kind: string, text: string) => boolean = () => true): Sample[] {
  const base = validOf(schema);
  const samples: Sample[] = [{ kind: 'base', pointer: '/', text: json(base) }];
  const seen = new Set<string>();
  for (const change of changesAt(schema, base, [])) {
    if (!only(change.kind, change.text)) continue;
    const text = json(replaceAt(base, change.path)).replace(json(SENTINEL), () => change.text);
    // One sample per (kind, text): a schema reached twice adds nothing.
    const key = `${change.kind}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    samples.push({ kind: change.kind, pointer: pointerOf(change.path), text });
  }
  return samples;
}

/** Every keyword used anywhere in `schema`. */
export function keywordsOf(schema: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) keywordsOf(item, found);
  } else if (schema !== null && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      found.add(key);
      if (key === 'properties') {
        for (const property of Object.values(value as Record<string, unknown>)) keywordsOf(property, found);
      } else if (key !== 'const' && key !== 'required' && key !== 'default') {
        keywordsOf(value, found);
      }
    }
  }
  return found;
}

export const FORMAT_NAMES: readonly string[] = Object.keys(FORMATS);
export const PATTERN_SOURCES: readonly string[] = Object.keys(PATTERNS);
