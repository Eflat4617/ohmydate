import type { IconName } from '../components/ui/icons';
import type { MessageKey } from '../i18n';

/**
 * The app's navigation, said once (HOLO-01): the sidebar renders the groups,
 * the phone's "더 보기" sheet renders the same links, and the top bar reads the
 * breadcrumb (group / screen) of the current route from it.
 */
export interface NavItem {
  readonly to: string;
  readonly label: MessageKey;
  readonly icon: IconName;
  /** Single-key shortcut shown beside the label (handled in AppShell). */
  readonly shortcut?: string;
  /** Route names that belong to this item (the first is its own). */
  readonly routes: readonly string[];
}

export interface NavGroup {
  readonly id: 'main' | 'planning' | 'ai' | 'settings';
  readonly label: MessageKey;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: 'main',
    label: 'nav.groupMain',
    items: [
      { to: '/overview', label: 'nav.overview', icon: 'overview', shortcut: 'o', routes: ['overview'] },
      { to: '/today', label: 'nav.today', icon: 'today', shortcut: 't', routes: ['today'] },
      // HOLO-02: the timer and the week's record of it.
      { to: '/tracker', label: 'nav.tracker', icon: 'timer', routes: ['tracker'] },
      // HOLO-02: 플래너 (일 · 주 · 월). `/month` is its 월 view and belongs to it.
      { to: '/planner', label: 'nav.planner', icon: 'month', shortcut: 'm', routes: ['planner', 'month'] },
      { to: '/inbox', label: 'nav.inbox', icon: 'inbox', routes: ['inbox'] },
      { to: '/projects', label: 'nav.projects', icon: 'projects', routes: ['projects', 'project'] },
      { to: '/notes', label: 'nav.notes', icon: 'note', routes: ['notes', 'notes-new', 'notes-detail'] },
    ],
  },
  {
    id: 'planning',
    label: 'nav.groupPlanning',
    items: [
      { to: '/plan/new', label: 'nav.plan', icon: 'plan', routes: ['plan-new', 'plan-session'] },
      { to: '/plan/schedule', label: 'nav.newPlan', icon: 'compare', routes: ['plan-scope', 'plan-schedule'] },
      { to: '/replan', label: 'nav.replan', icon: 'reschedule', routes: ['replan', 'replan-proposal'] },
      { to: '/commitments', label: 'nav.commitments', icon: 'commitment', routes: ['commitments'] },
      { to: '/settings/availability', label: 'nav.availability', icon: 'availability', routes: ['availability'] },
    ],
  },
  {
    id: 'ai',
    label: 'nav.groupAi',
    items: [{ to: '/patterns', label: 'nav.patterns', icon: 'pattern', routes: ['patterns'] }],
  },
  {
    id: 'settings',
    label: 'nav.groupSettings',
    items: [
      { to: '/settings/calendar', label: 'nav.calendarSettings', icon: 'link', routes: ['calendar-settings'] },
      { to: '/settings/ai', label: 'nav.aiSettings', icon: 'ai', routes: ['ai-settings'] },
      { to: '/settings/layout', label: 'nav.layoutSettings', icon: 'layout', routes: ['layout-settings'] },
    ],
  },
];

export interface Crumb {
  readonly group: MessageKey;
  readonly page: MessageKey;
}

/** Screens reached from another screen, not from the sidebar. */
const DETAIL_CRUMBS: Readonly<Record<string, Crumb>> = {
  task: { group: 'nav.groupMain', page: 'nav.crumbTask' },
  focus: { group: 'nav.groupMain', page: 'nav.crumbFocus' },
};

/** The breadcrumb of a route name; null for a route the navigation does not know. */
export function crumbFor(routeName: unknown): Crumb | null {
  if (typeof routeName !== 'string') return null;
  for (const group of NAV_GROUPS) {
    const item = group.items.find((entry) => entry.routes.includes(routeName));
    if (item !== undefined) return { group: group.label, page: item.label };
  }
  return DETAIL_CRUMBS[routeName] ?? null;
}

/** True when `routeName` belongs to the item (its own route or one under it). */
export function isNavItemCurrent(item: NavItem, routeName: unknown): boolean {
  return typeof routeName === 'string' && item.routes.includes(routeName);
}

/** The phone's bottom bar holds these itself; everything else is in "더 보기". */
export const BOTTOM_BAR_ROUTES: ReadonlySet<string> = new Set(['today', 'inbox', 'plan-new', 'plan-session', 'focus']);

/** Every link of the sidebar that the phone's bottom bar does not show. */
export const MORE_LINKS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items).filter(
  (item) => !['/today', '/inbox', '/plan/new'].includes(item.to),
);
