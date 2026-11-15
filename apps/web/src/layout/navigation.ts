import type { IconName } from '../components/ui/icons';
import type { MessageKey } from '../i18n';

/**
 * The app's places, said once (HOLO-04, FLOW.md §4). The sidebar is the loop
 * in its own order — 개요 → 할 일 → 계획 → 플래너 → 집중 → 분석 → 노트 — with
 * 설정 below it. The sidebar, the phone's bar and its "더 보기" sheet, the
 * breadcrumb and the single-key shortcuts all read this list.
 */
export interface NavItem {
  readonly id: string;
  readonly to: string;
  readonly label: MessageKey;
  readonly icon: IconName;
  /** Single-key shortcut shown beside the label (handled in AppShell). */
  readonly shortcut?: string;
  /** Route names that belong to this place (the first is its own). */
  readonly routes: readonly string[];
}

/** The loop, in order. */
export const NAV_PLACES: readonly NavItem[] = [
  // What do I do now: the next block, today, the week.
  { id: 'overview', to: '/overview', label: 'nav.overview', icon: 'overview', shortcut: 'o', routes: ['overview'] },
  // ① 담기: everything put down so far; projects are its folders.
  { id: 'tasks', to: '/tasks', label: 'nav.tasks', icon: 'inbox', shortcut: 't', routes: ['tasks', 'project', 'task'] },
  // ② 계획 and ⑥ 다시 맞추기: the plan flow, plans under way, proposals and their history.
  {
    id: 'plan',
    to: '/plan',
    label: 'nav.plan',
    icon: 'plan',
    shortcut: 'p',
    routes: ['plan', 'plan-session', 'plan-scope', 'plan-schedule', 'replan', 'replan-proposal'],
  },
  // 일 · 주 · 월 · 약속: blocks, appointments and deadlines. `/month` is its 월 view.
  { id: 'planner', to: '/planner', label: 'nav.planner', icon: 'month', shortcut: 'm', routes: ['planner', 'month'] },
  // ④ 집중: the timer and the record of it.
  { id: 'focus', to: '/focus', label: 'nav.focus', icon: 'timer', shortcut: 'f', routes: ['focus-home', 'focus'] },
  // ⑤ 돌아보기 over weeks: how the owner works.
  { id: 'insights', to: '/insights', label: 'nav.insights', icon: 'pattern', routes: ['insights'] },
  { id: 'notes', to: '/notes', label: 'nav.notes', icon: 'note', routes: ['notes', 'notes-new', 'notes-detail'] },
];

/** Below the loop: where things are changed later, never where one has to go first. */
export const NAV_SETTINGS: NavItem = {
  id: 'settings',
  to: '/settings',
  label: 'nav.settings',
  icon: 'settings',
  routes: ['settings'],
};

export const NAV_ITEMS: readonly NavItem[] = [...NAV_PLACES, NAV_SETTINGS];

export interface Crumb {
  /** The place in the sidebar. */
  readonly place: MessageKey;
  /** The screen under it, when the route is not the place's own. */
  readonly page: MessageKey | null;
}

/** Screens under a place that have a name of their own. */
const DETAIL_PAGES: Readonly<Record<string, MessageKey>> = {
  task: 'nav.crumbTask',
  project: 'nav.crumbProject',
  focus: 'nav.crumbTimer',
  replan: 'nav.crumbReplan',
  'replan-proposal': 'nav.crumbReplan',
};

/** The place a route belongs to; null for a route the navigation does not know. */
export function navItemFor(routeName: unknown): NavItem | null {
  if (typeof routeName !== 'string') return null;
  return NAV_ITEMS.find((item) => item.routes.includes(routeName)) ?? null;
}

/** The breadcrumb of a route name; null for a route the navigation does not know. */
export function crumbFor(routeName: unknown): Crumb | null {
  const item = navItemFor(routeName);
  if (item === null || typeof routeName !== 'string') return null;
  return { place: item.label, page: DETAIL_PAGES[routeName] ?? null };
}

/** True when `routeName` belongs to the item (its own route or one under it). */
export function isNavItemCurrent(item: NavItem, routeName: unknown): boolean {
  return typeof routeName === 'string' && item.routes.includes(routeName);
}

/** The phone's bar holds these three places itself (and 담기 between them). */
export const BOTTOM_BAR_PLACES: readonly NavItem[] = NAV_PLACES.filter((item) =>
  ['overview', 'tasks', 'plan'].includes(item.id),
);

/** Every place the phone's bar does not show: the "더 보기" sheet, in the sidebar's order. */
export const MORE_LINKS: readonly NavItem[] = NAV_ITEMS.filter((item) => !BOTTOM_BAR_PLACES.includes(item));
