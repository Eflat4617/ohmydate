/**
 * Colour arithmetic for tests that check the design tokens (HOLO-04): OKLCH to
 * sRGB, WCAG 2.x relative luminance and contrast, source-over compositing the
 * way a browser does it (on encoded sRGB values), and the two backdrop-filter
 * functions the glass uses that change lightness.
 */

/** Linear-light sRGB, each channel 0..1. */
export type Rgb = readonly [number, number, number];

export interface Colour {
  readonly rgb: Rgb;
  /** 0..1 */
  readonly alpha: number;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `L` and `alpha` 0..1, `C` as written, `H` in degrees. Out-of-gamut channels are clipped. */
export function oklch(L: number, C: number, H: number, alpha = 1): Colour {
  const hue = (H * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    rgb: [
      clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ],
    alpha,
  };
}

/** `oklch(20% 0.012 150 / 72%)`, `oklch(100% 0 0)`. Null for anything else. */
export function parseOklch(value: string): Colour | null {
  const match = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+)%)?\s*\)$/.exec(value.trim());
  if (match === null) return null;
  return oklch(Number(match[1]) / 100, Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4]) / 100);
}

const encode = (value: number): number => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
const decode = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

/** `#rrggbb`, the way a browser would write the colour for a tag that takes no `oklch()`. */
export function toHex(colour: Colour): string {
  return `#${colour.rgb
    .map((channel) =>
      Math.round(clamp(encode(channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function luminance(rgb: Rgb): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export function contrast(left: Rgb, right: Rgb): number {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `top` painted over an opaque `bottom`. */
export function over(top: Colour, bottom: Rgb): Rgb {
  return [0, 1, 2].map((index) =>
    decode(encode(top.rgb[index] ?? 0) * top.alpha + encode(bottom[index] ?? 0) * (1 - top.alpha)),
  ) as unknown as Rgb;
}

export type LightnessFilter = readonly ['brightness' | 'contrast', number];

/**
 * The `brightness()` and `contrast()` functions of a filter list, in the order
 * written. (`blur()` only averages what is behind and `saturate()` keeps a
 * neutral backdrop as it is, so neither moves the worst case.)
 */
export function parseLightnessFilters(value: string): LightnessFilter[] {
  return Array.from(value.matchAll(/(brightness|contrast)\(\s*([\d.]+)\s*\)/g)).map(
    (match) => [match[1] as 'brightness' | 'contrast', Number(match[2])] as const,
  );
}

export function applyFilters(rgb: Rgb, filters: readonly LightnessFilter[]): Rgb {
  return rgb.map((channel) => {
    let value = encode(channel);
    for (const [kind, amount] of filters) {
      value = kind === 'brightness' ? value * amount : (value - 0.5) * amount + 0.5;
      value = clamp(value);
    }
    return decode(value);
  }) as unknown as Rgb;
}

/** The declarations of one rule block of a stylesheet, by custom property name. */
export function customProperties(css: string, selectorStart: string): Map<string, string> {
  const start = css.indexOf(selectorStart);
  if (start === -1) throw new Error(`no rule starts with ${selectorStart}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' ').trim());
  }
  return found;
}
