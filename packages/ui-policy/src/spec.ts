import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  ITEM_SCHEMAS,
  LAYOUT_MODES,
  LAYOUT_REASONS,
  LAYOUT_REGIONS,
  LAYOUT_SPEC_ID,
  LayoutItemSchema,
  MAX_ITEMS_PER_REGION,
  PINNED_COMPONENTS,
  POLICY_VERSION_PATTERN,
  isLayoutComponentId,
  isPageComponent,
  literalUnion,
  type LayoutComponentId,
  type LayoutItem,
  type LayoutRegion,
} from './registry.js';

/** `ui.layout.v1` (07 §2.1). */
export const LayoutSpecSchema = Type.Object(
  {
    mode: literalUnion(LAYOUT_MODES),
    regions: Type.Object(
      {
        primary: Type.Array(LayoutItemSchema, { minItems: 1, maxItems: MAX_ITEMS_PER_REGION }),
        secondary: Type.Array(LayoutItemSchema, { maxItems: MAX_ITEMS_PER_REGION }),
        tertiary: Type.Array(LayoutItemSchema, { maxItems: MAX_ITEMS_PER_REGION }),
      },
      { additionalProperties: false },
    ),
    pinned: Type.Array(literalUnion(PINNED_COMPONENTS), {
      minItems: PINNED_COMPONENTS.length,
      maxItems: PINNED_COMPONENTS.length,
      uniqueItems: true,
    }),
    reason: literalUnion(LAYOUT_REASONS),
    policyVersion: Type.String({ pattern: POLICY_VERSION_PATTERN, maxLength: 32 }),
  },
  { additionalProperties: false, $id: LAYOUT_SPEC_ID },
);

export type LayoutSpec = Static<typeof LayoutSpecSchema>;
export type LayoutRegions = LayoutSpec['regions'];

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const MAX_ERRORS = 20;

/**
 * Error lines name the JSON path and the rule, never the offending value, so
 * they are safe to log (AGENTS: no content in logs).
 */
function schemaErrors(schema: TSchema, value: unknown, prefix: string): string[] {
  const errors: string[] = [];
  for (const error of Value.Errors(schema, value)) {
    errors.push(`${prefix}${error.path || '/'}: ${error.message}`);
    if (errors.length >= MAX_ERRORS) break;
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Per-item check with the component's own props schema, for precise errors. */
function itemErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path}: expected an object`];
  const component = value['component'];
  if (!isLayoutComponentId(component)) return [`${path}/component: not a registered component`];
  return schemaErrors(ITEM_SCHEMAS[component], value, path);
}

function sessionIdOf(item: LayoutItem): string | null {
  if (item.component === 'FocusTimer' || item.component === 'CurrentTaskCard' || item.component === 'ActiveSessionCard') {
    return item.props.sessionId;
  }
  return null;
}

/** Rules a JSON Schema cannot say: one page, unique components, nav pinned. */
function semanticErrors(spec: LayoutSpec): string[] {
  const errors: string[] = [];
  const seen = new Set<LayoutComponentId>();
  const pages: { region: LayoutRegion; component: LayoutComponentId }[] = [];
  const sessionIds = new Set<string>();
  for (const region of LAYOUT_REGIONS) {
    spec.regions[region].forEach((item, index) => {
      if (seen.has(item.component)) {
        errors.push(`/regions/${region}/${index}/component: duplicate component`);
      }
      seen.add(item.component);
      if (isPageComponent(item.component)) pages.push({ region, component: item.component });
      const sessionId = sessionIdOf(item);
      if (sessionId !== null) sessionIds.add(sessionId);
    });
  }
  if (pages.length !== 1) errors.push(`/regions: expected exactly one page component, found ${pages.length}`);
  for (const page of pages) {
    if (page.region !== 'primary') errors.push(`/regions/${page.region}: page component must be in primary`);
  }
  if (sessionIds.size > 1) errors.push('/regions: session components must refer to one session');
  if (seen.has('FocusTimer') && spec.mode !== 'focus') errors.push('/mode: FocusTimer requires focus mode');
  for (const pinned of PINNED_COMPONENTS) {
    if (!spec.pinned.includes(pinned)) errors.push(`/pinned: ${pinned} must stay pinned`);
  }
  return errors;
}

/**
 * Validates an untrusted LayoutSpec (policy output, persisted state or an AI
 * suggestion). Callers keep their previous layout when this fails (07 §2.1).
 */
export function validateLayoutSpec(value: unknown): ValidationResult<LayoutSpec> {
  if (!isRecord(value)) return { ok: false, errors: ['/: expected an object'] };
  const errors: string[] = [];
  const regions = value['regions'];
  if (isRecord(regions)) {
    for (const region of LAYOUT_REGIONS) {
      const items = regions[region];
      if (Array.isArray(items)) {
        items.forEach((item, index) => errors.push(...itemErrors(item, `/regions/${region}/${index}`)));
      }
    }
  }
  if (errors.length === 0) errors.push(...schemaErrors(LayoutSpecSchema, value, ''));
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  const spec = value as LayoutSpec;
  const semantic = semanticErrors(spec);
  if (semantic.length > 0) return { ok: false, errors: semantic };
  return { ok: true, value: spec };
}

export function pageItemOf(spec: LayoutSpec): LayoutItem | null {
  for (const item of spec.regions.primary) {
    if (isPageComponent(item.component)) return item;
  }
  return null;
}

export function componentsOf(spec: LayoutSpec): LayoutComponentId[] {
  return LAYOUT_REGIONS.flatMap((region) => spec.regions[region].map((item) => item.component));
}

/** Same mode and the same components in the same regions (props may differ). */
export function sameStructure(left: LayoutSpec, right: LayoutSpec): boolean {
  if (left.mode !== right.mode) return false;
  return LAYOUT_REGIONS.every((region) => {
    const a = left.regions[region];
    const b = right.regions[region];
    return a.length === b.length && a.every((item, index) => item.component === b[index]?.component);
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (isRecord(inner)) {
      return Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]));
    }
    return inner;
  });
}

/** Deep equality of everything that affects rendering or announcements. */
export function sameLayout(left: LayoutSpec, right: LayoutSpec): boolean {
  return (
    left.mode === right.mode &&
    left.reason === right.reason &&
    canonical(left.regions) === canonical(right.regions)
  );
}
