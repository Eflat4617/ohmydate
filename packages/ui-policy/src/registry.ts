import { Type, type Static, type TLiteral, type TSchema, type TUnion } from '@sinclair/typebox';

/**
 * Closed vocabulary of the adaptive layout (07 §2). Everything a LayoutSpec can
 * name is listed here; the web renderer maps exactly these ids to components.
 */

export const POLICY_VERSION = 'ui-policy@0.1.0' as const;
export const LAYOUT_SPEC_ID = 'ui.layout.v1' as const;

/** Modes in 07 §2.2 priority order (the lock is a preference, not a mode). */
export const LAYOUT_MODES = ['focus', 'planning', 'deadline_risk', 'review', 'notes', 'overview'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const LAYOUT_REASONS = [
  'locked',
  'active_session',
  'planning_route',
  'deadline_risk',
  'review_window',
  'notes_route',
  'default',
  'user_navigation',
  'ai_suggestion',
] as const;
export type LayoutReason = (typeof LAYOUT_REASONS)[number];

export const LAYOUT_REGIONS = ['primary', 'secondary', 'tertiary'] as const;
export type LayoutRegion = (typeof LAYOUT_REGIONS)[number];

/** Components that are a whole screen; a spec holds exactly one, in `primary`. */
export const PAGE_COMPONENTS = ['TodayPlan', 'FocusTimer', 'PlanningWorkspace', 'NotesWorkspace'] as const;
export type PageComponentId = (typeof PAGE_COMPONENTS)[number];

/** Context panels placed around the page. */
export const PANEL_COMPONENTS = [
  'CurrentTaskCard',
  'NextUp',
  'RelatedNotes',
  'DeadlineRiskPanel',
  'ReviewPrompt',
  'ActiveSessionCard',
] as const;
export type PanelComponentId = (typeof PANEL_COMPONENTS)[number];

export const LAYOUT_COMPONENTS = [...PAGE_COMPONENTS, ...PANEL_COMPONENTS] as const;
export type LayoutComponentId = (typeof LAYOUT_COMPONENTS)[number];

/** Core navigation: always rendered, never part of a region (07 §2.3). */
export const PINNED_COMPONENTS = ['NavRail', 'BottomNav'] as const;
export type PinnedComponentId = (typeof PINNED_COMPONENTS)[number];

export const MAX_ITEMS_PER_REGION = 3;
export const MAX_COUNT = 5;

/** Any RFC 4122 UUID in lower-case canonical form (sessions are UUIDv7). */
export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const POLICY_VERSION_PATTERN = '^ui-policy@[0-9]+\\.[0-9]+\\.[0-9]+$';

export function literalUnion<const T extends readonly string[]>(values: T): TUnion<TLiteral<T[number]>[]> {
  return Type.Union(values.map((value) => Type.Literal(value))) as TUnion<TLiteral<T[number]>[]>;
}

// Props are closed objects with ids and small integers only: no free text, so
// no HTML, script, URL or style string can travel inside a spec.
const SessionId = Type.String({ pattern: UUID_PATTERN, maxLength: 36 });
const Count = Type.Integer({ minimum: 1, maximum: MAX_COUNT });

export const NoPropsSchema = Type.Object({}, { additionalProperties: false });
export const SessionPropsSchema = Type.Object({ sessionId: SessionId }, { additionalProperties: false });
export const NextUpPropsSchema = Type.Object({ count: Count }, { additionalProperties: false });
export const RelatedNotesPropsSchema = Type.Object({ limit: Count }, { additionalProperties: false });

export const COMPONENT_PROPS_SCHEMAS = {
  TodayPlan: NoPropsSchema,
  FocusTimer: SessionPropsSchema,
  PlanningWorkspace: NoPropsSchema,
  NotesWorkspace: NoPropsSchema,
  CurrentTaskCard: SessionPropsSchema,
  NextUp: NextUpPropsSchema,
  RelatedNotes: RelatedNotesPropsSchema,
  DeadlineRiskPanel: NoPropsSchema,
  ReviewPrompt: NoPropsSchema,
  ActiveSessionCard: SessionPropsSchema,
} as const satisfies Record<LayoutComponentId, TSchema>;

/** Components whose props object may be omitted (it has no fields). */
export const PROPLESS_COMPONENTS: ReadonlySet<LayoutComponentId> = new Set([
  'TodayPlan',
  'PlanningWorkspace',
  'NotesWorkspace',
  'DeadlineRiskPanel',
  'ReviewPrompt',
]);

const closed = { additionalProperties: false } as const;

export const TodayPlanItemSchema = Type.Object(
  { component: Type.Literal('TodayPlan'), props: Type.Optional(NoPropsSchema) },
  closed,
);
export const FocusTimerItemSchema = Type.Object(
  { component: Type.Literal('FocusTimer'), props: SessionPropsSchema },
  closed,
);
export const PlanningWorkspaceItemSchema = Type.Object(
  { component: Type.Literal('PlanningWorkspace'), props: Type.Optional(NoPropsSchema) },
  closed,
);
export const NotesWorkspaceItemSchema = Type.Object(
  { component: Type.Literal('NotesWorkspace'), props: Type.Optional(NoPropsSchema) },
  closed,
);
export const CurrentTaskCardItemSchema = Type.Object(
  { component: Type.Literal('CurrentTaskCard'), props: SessionPropsSchema },
  closed,
);
export const NextUpItemSchema = Type.Object({ component: Type.Literal('NextUp'), props: NextUpPropsSchema }, closed);
export const RelatedNotesItemSchema = Type.Object(
  { component: Type.Literal('RelatedNotes'), props: RelatedNotesPropsSchema },
  closed,
);
export const DeadlineRiskPanelItemSchema = Type.Object(
  { component: Type.Literal('DeadlineRiskPanel'), props: Type.Optional(NoPropsSchema) },
  closed,
);
export const ReviewPromptItemSchema = Type.Object(
  { component: Type.Literal('ReviewPrompt'), props: Type.Optional(NoPropsSchema) },
  closed,
);
export const ActiveSessionCardItemSchema = Type.Object(
  { component: Type.Literal('ActiveSessionCard'), props: SessionPropsSchema },
  closed,
);

export const ITEM_SCHEMAS = {
  TodayPlan: TodayPlanItemSchema,
  FocusTimer: FocusTimerItemSchema,
  PlanningWorkspace: PlanningWorkspaceItemSchema,
  NotesWorkspace: NotesWorkspaceItemSchema,
  CurrentTaskCard: CurrentTaskCardItemSchema,
  NextUp: NextUpItemSchema,
  RelatedNotes: RelatedNotesItemSchema,
  DeadlineRiskPanel: DeadlineRiskPanelItemSchema,
  ReviewPrompt: ReviewPromptItemSchema,
  ActiveSessionCard: ActiveSessionCardItemSchema,
} as const satisfies Record<LayoutComponentId, TSchema>;

export const LayoutItemSchema = Type.Union([
  TodayPlanItemSchema,
  FocusTimerItemSchema,
  PlanningWorkspaceItemSchema,
  NotesWorkspaceItemSchema,
  CurrentTaskCardItemSchema,
  NextUpItemSchema,
  RelatedNotesItemSchema,
  DeadlineRiskPanelItemSchema,
  ReviewPromptItemSchema,
  ActiveSessionCardItemSchema,
]);
export type LayoutItem = Static<typeof LayoutItemSchema>;

export function isLayoutComponentId(value: unknown): value is LayoutComponentId {
  return typeof value === 'string' && (LAYOUT_COMPONENTS as readonly string[]).includes(value);
}

export function isPageComponent(id: LayoutComponentId): id is PageComponentId {
  return (PAGE_COMPONENTS as readonly string[]).includes(id);
}

export function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === 'string' && (LAYOUT_MODES as readonly string[]).includes(value);
}
