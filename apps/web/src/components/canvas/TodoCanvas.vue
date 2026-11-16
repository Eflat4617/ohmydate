<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue';
import type { Project, Task } from '../../api';
import type { CanvasMemory } from '../../composables/canvasMemory';
import { useMediaQuery } from '../../composables/useMediaQuery';
import { createGovernor, governorTick, type MotionLevel } from '../../domain/canvas/governor';
import {
  INSIDE_SWAY,
  NARROW_GROWTH,
  NARROW_SURFACE,
  NARROW_SWAY,
  SWAY_REACH,
  bodiesIn,
  bodySpacing,
  dishAreaOf,
  estimateCapsule,
  flowPlaces,
  folderAt,
  footprintOf,
  fractionOf,
  freeSpot,
  layoutFolders,
  openWater,
  placeBodies,
  planDensity,
  pointOf,
  regionBox,
  worldOf,
  type FolderBox,
  type FolderInput,
  type Fraction,
  type SeedItem,
} from '../../domain/canvas/layout';
import { edgeOf, neighbour, readingOrder, type Direction } from '../../domain/canvas/order';
import { NO_SELECTION, all, extendTo, lasso, ordered, prune, toggle, type Selection } from '../../domain/canvas/selection';
import { REST_EPSILON, createBody, easeDrift, relax, settle, swayAt, type Body, type Point, type World } from '../../domain/canvas/sim';
import { dueToneOf, type CanvasTodo } from '../../domain/canvas/todo';
import { projectHue } from '../../domain/overview';
import { captureOwnerBinding, type OwnerBinding } from '../../session/ownerEpoch';
import { placeCard } from '../../domain/weekGrid';
import { t, tp } from '../../i18n';
import { formatDate, formatDateTime } from '../../i18n/format';
import UiButton from '../ui/UiButton.vue';
import UiEmptyState from '../ui/UiEmptyState.vue';
import UiIcon from '../ui/UiIcon.vue';
import FolderPicker from './FolderPicker.vue';
import TodoDetailCard from './TodoDetailCard.vue';
import type { CanvasActions } from './types';

/**
 * 할 일, the canvas (HOLO-05). Every open to-do is a small capsule of still
 * glass floating on a wide surface; a folder is a dish on it. The inbox is
 * the open water outside the dishes.
 *
 * **It is built in the DOM.** A capsule is a real element with a name, in the
 * tab order, that can be read, clicked, dragged and opened. It is placed with
 * one CSS transform, written by one small loop (domain/canvas/sim.ts): each
 * to-do is moored to the place it was left and sways a few pixels around it.
 * Near the pointer things hold still; under reduced motion and in a hidden
 * tab nothing moves, and the picture is the same one.
 *
 * **To assistive technology it is a list.** One listbox (one tab stop, many
 * can be picked), a group for the inbox and one for each folder, an option a
 * to-do. The arrow keys go to the nearest to-do that way, Enter opens the
 * detail, Space picks, `v` files into a folder, Alt+arrow moves a to-do.
 *
 * The canvas draws and moves; what is sent to the server is the place's
 * business (`actions`). Offline (`disabled`) it can still be arranged — where
 * things are is this device's — but nothing is filed, finished or changed.
 */
const props = defineProps<{
  /** The open to-dos, most urgent first. */
  todos: readonly CanvasTodo<Task>[];
  folders: readonly Project[];
  memory: CanvasMemory;
  timeZone: string;
  disabled: boolean;
  /** Ids of the picked to-dos (`v-model:selected`). */
  selected: readonly string[];
  actions: CanvasActions;
}>();
const emit = defineEmits<{
  'update:selected': [ids: string[]];
  /** Where things are now, and the owner whose gesture put them there (a stale one writes nothing). */
  remember: [memory: CanvasMemory, binding: OwnerBinding];
  /** The empty surface's invitation: open the capture bar. */
  capture: [];
}>();

const px = (value: number): string => `${Math.round(value)}px`;

// ── The surface: its size, how much it shows ────────────────────────────
/** Where nothing can be measured (a test's DOM): a desktop's canvas. */
const FALLBACK_WIDTH = 1100;
const FALLBACK_ROOM = 640;
const MIN_ROOM = 420;
/** The least open water a narrow surface keeps, and the air around its stacked dishes. */
const MIN_WATER = 200;
const EMPTY_WATER = 280;
const DISH_STACK_GAP = 14;
const DISH_COLUMN_PAD = 12;

const stage = ref<HTMLElement | null>(null);
const width = ref(FALLBACK_WIDTH);
const room = ref(FALLBACK_ROOM);
const expanded = ref(false);
const narrow = computed(() => width.value < NARROW_SURFACE);

function measureStage(): void {
  const element = stage.value;
  if (element === null) return;
  if (element.clientWidth > 0) width.value = element.clientWidth;
  if (typeof window === 'undefined') return;
  // What the window leaves under the page's head (and, on a phone, over its nav).
  const top = element.getBoundingClientRect().top + window.scrollY;
  // Under it on a wide window: the line of keys and the page's own foot, so the page does not scroll.
  const reserve = window.innerWidth >= 1024 ? 100 : 104;
  const left = window.innerHeight - top - reserve;
  room.value = Math.max(MIN_ROOM, Number.isFinite(left) ? left : FALLBACK_ROOM);
}

const folded = computed(() => new Set(props.memory.folded));
/** A dish in the hand: where it is right now, before it is remembered. */
const liveFolderPlace = reactive(new Map<string, Fraction>());
/** To-dos on their way into another water: where they are going. */
const pendingRegion = reactive(new Map<string, string | null>());

function regionOf(todo: CanvasTodo<Task>): string | null {
  const pending = pendingRegion.get(todo.task.id);
  return pending === undefined ? todo.folderId : pending;
}

// Once the list itself says a to-do is where it was sent, the note is no longer needed.
watch(
  () => props.todos,
  (todos) => {
    if (pendingRegion.size === 0) return;
    for (const todo of todos) {
      if (pendingRegion.get(todo.task.id) === todo.folderId) pendingRegion.delete(todo.task.id);
    }
  },
);

const byRegion = computed(() => {
  const known = new Set(props.folders.map((folder) => folder.id));
  const map = new Map<string | null, CanvasTodo<Task>[]>();
  for (const todo of props.todos) {
    const region = regionOf(todo);
    if (region !== null && !known.has(region)) continue;
    const list = map.get(region);
    if (list === undefined) map.set(region, [todo]);
    else list.push(todo);
  }
  return map;
});

/** Bumped when capsules have been measured: the dishes are sized for the widths they really have. */
const measuredAt = ref(0);
/** Ids in the order they are drawn into the DOM: the reading order, group by group. */
const renderOrder = shallowRef<string[]>([]);

const folderInputs = computed<FolderInput[]>(() => {
  void measuredAt.value;
  // A dish is sized for its to-dos in the order it keeps them: where they were left, else most urgent first.
  const order = new Map(renderOrder.value.map((id, index) => [id, index]));
  const position = (todo: CanvasTodo<Task>): number => order.get(todo.task.id) ?? Number.MAX_SAFE_INTEGER;
  return props.folders.map((folder) => {
    const filed = [...(byRegion.value.get(folder.id) ?? [])].sort((a, b) => position(a) - position(b));
    return {
      id: folder.id,
      count: filed.length,
      collapsed: folded.value.has(folder.id),
      place: liveFolderPlace.get(folder.id) ?? props.memory.folders[folder.id],
      labelLength: [...folder.title].length,
      widths: filed.map((todo) => sizeOf(todo).w),
    };
  });
});

/** The dishes before the surface's height is known: their sizes do not depend on it. */
const dishSizes = computed(() => layoutFolders(folderInputs.value, { width: width.value, height: room.value }));
/**
 * A narrow surface is a vertical field: the open water first, then the dishes
 * stacked under it. The water is as tall as its to-dos ask for — up to what
 * the window leaves — and the dishes add their own height below.
 */
const dishStack = computed(() => {
  if (!narrow.value || dishSizes.value.length === 0) return 0;
  return dishSizes.value.reduce((sum, dish) => sum + dish.box.height + DISH_STACK_GAP, 0) + DISH_STACK_GAP;
});
const waterRoom = computed(() => {
  if (!narrow.value) {
    // The dishes stand in one column down the right edge: the surface is at
    // least as tall as that column (up to two windows), so they never spill
    // into the water as a second column.
    // (Counted as layoutFolders lays them out: a gap between two, and the surface's pad at both ends.)
    const dishes = dishSizes.value;
    const column = dishes.reduce((sum, dish) => sum + dish.box.height, 0) + Math.max(0, dishes.length - 1) * DISH_STACK_GAP + 2 * DISH_COLUMN_PAD;
    return Math.max(room.value, Math.min(column, room.value * 2));
  }
  const open = byRegion.value.get(null)?.length ?? 0;
  const asked = Math.ceil((open * footprintOf('airy', width.value)) / Math.max(1, width.value)) + 2 * DISH_STACK_GAP;
  // Empty water still holds its invitation.
  return Math.max(open === 0 ? EMPTY_WATER : MIN_WATER, Math.min(asked, room.value));
});

/**
 * The open water the density rule plans for. With the dishes in their band
 * down the right edge it is the surface beside that band (so a narrow strip of
 * water is not counted as if it were the whole surface); with dishes the
 * owner moved into the middle it is the surface less their area.
 */
const waterWidth = computed(() => {
  if (narrow.value || dishSizes.value.length === 0) return width.value;
  return openWater(worldOf({ width: width.value, height: waterRoom.value }, layoutFolders(folderInputs.value, { width: width.value, height: waterRoom.value }))).width;
});

const plan = computed(() =>
  planDensity({
    count: byRegion.value.get(null)?.length ?? 0,
    width: waterWidth.value,
    baseHeight: waterRoom.value,
    dishArea: narrow.value || waterWidth.value < width.value ? 0 : dishAreaOf(dishSizes.value),
    expanded: expanded.value,
    ...(narrow.value ? { growth: NARROW_GROWTH } : {}),
  }),
);
const surface = computed(() => ({ width: width.value, height: plan.value.height + dishStack.value }));
const folderBoxes = computed<FolderBox[]>(() => layoutFolders(folderInputs.value, surface.value));
const world = computed<World>(() => worldOf(surface.value, folderBoxes.value));
/** The simulation's distances; a seeded field is centred on the first window of a long surface. */
/** The open water as it is laid out: where the foot bar and the empty surface's invitation stand. */
const waterBox = computed(() => openWater(world.value));
const bodyOptions = computed(() => ({ ...bodySpacing(plan.value.density), focusY: Math.min(plan.value.height, waterRoom.value) / 2 }));

/** The to-dos that are drawn: the open water's most urgent, and what each open dish can show. */
const shown = computed<CanvasTodo<Task>[]>(() => {
  const list = (byRegion.value.get(null) ?? []).slice(0, plan.value.shown);
  for (const box of folderBoxes.value) {
    if (box.collapsed) continue;
    list.push(...(byRegion.value.get(box.id) ?? []).slice(0, box.shown));
  }
  return list;
});
const folderById = computed(() => new Map(props.folders.map((folder) => [folder.id, folder])));

// ── What a capsule says ─────────────────────────────────────────────────
function dueText(todo: CanvasTodo<Task>): string {
  const due = todo.due;
  if (due === null) return '';
  switch (due.kind) {
    case 'overdue':
      return due.days === 0 ? t('canvas.todo.overdueToday') : tp('canvas.todo.overdueDays', due.days);
    case 'today':
      return t('canvas.todo.today');
    case 'tomorrow':
      return t('canvas.todo.tomorrow');
    case 'days':
      return tp('canvas.todo.inDays', due.days);
    default:
      return formatDate(todo.task.dueAt as string, props.timeZone, { weekday: false });
  }
}

/** What a screen reader hears for one to-do: its title, then what matters about it. */
function nameOf(todo: CanvasTodo<Task>): string {
  const task = todo.task;
  const parts = [task.title];
  if (task.status === 'in_progress') parts.push(t('canvas.todo.inProgress'));
  if (task.dueAt !== undefined) {
    parts.push(t('canvas.todo.nameDue', { when: formatDateTime(task.dueAt, props.timeZone) }));
    if (todo.overdue) parts.push(t('task.overdue'));
  }
  if (todo.planned) parts.push(t('canvas.todo.planned'));
  const folder = todo.folderId === null ? undefined : folderById.value.get(todo.folderId);
  parts.push(folder === undefined ? t('canvas.todo.nameInbox') : t('canvas.todo.nameFolder', { title: folder.title }));
  return parts.join(', ');
}

// ── Bodies: anchors, sizes, the picture ─────────────────────────────────
const bodies = new Map<string, Body>();
let bodyList: Body[] = [];
const bodyEls = new Map<string, HTMLElement>();
const painted = new Map<string, string>();
const measured = new Map<string, { key: string; w: number; h: number }>();
const known = new Set<string>();
let ready = false;
let prevWorld: World | null = null;

/** Just put down: they arrive with a small entrance. */
const arriving = reactive(new Set<string>());
/**
 * To-dos on their way out. `finishing` is asked of the server and still
 * there; `leaving` has been finished and stays a moment for its exit. Both
 * keep their body even after the list stops naming them.
 */
const ghosts = reactive(new Map<string, { todo: CanvasTodo<Task>; state: 'finishing' | 'leaving' }>());
const ARRIVE_MS = 900;
const LEAVE_MS = 560;
const LEAVING_REGION = ' leaving';
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(run: () => void, ms: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    run();
  }, ms);
  timers.add(timer);
}

/** A to-do in a folder is put away: it is drawn at the compact size whatever the open water's. */
function densityOf(todo: CanvasTodo<Task>): 'airy' | 'compact' {
  return regionOf(todo) === null ? plan.value.density : 'compact';
}

function sizeKey(todo: CanvasTodo<Task>): string {
  return `${densityOf(todo)}|${todo.depth}|${todo.task.title}|${dueText(todo)}|${todo.planned ? 1 : 0}`;
}

function sizeOf(todo: CanvasTodo<Task>): { w: number; h: number } {
  const cached = measured.get(todo.task.id);
  if (cached !== undefined && cached.key === sizeKey(todo)) return { w: cached.w, h: cached.h };
  return estimateCapsule(todo.task.title, todo.depth, densityOf(todo), dueText(todo));
}

/** Read the real size of every capsule that has not been measured as it is now. True when one differed. */
function measureBodies(): boolean {
  let changed = false;
  let filedMeasured = false;
  for (const todo of shown.value) {
    const id = todo.task.id;
    const key = sizeKey(todo);
    if (measured.get(id)?.key === key) continue;
    const element = bodyEls.get(id);
    if (element === undefined || element.offsetWidth === 0) continue;
    const size = { w: element.offsetWidth, h: element.offsetHeight };
    measured.set(id, { key, ...size });
    if (regionOf(todo) !== null) filedMeasured = true;
    const body = bodies.get(id);
    if (body !== undefined && (Math.abs(body.w - size.w) > 0.5 || Math.abs(body.h - size.h) > 0.5)) {
      body.w = size.w;
      body.h = size.h;
      changed = true;
    }
  }
  // A folder's dish follows the widths of what is in it.
  if (filedMeasured) measuredAt.value += 1;
  return changed;
}

function savedPlaces(): Map<string, Fraction> {
  return new Map(Object.entries(props.memory.places));
}

function refreshOrder(): void {
  const ids: string[] = [];
  const regions: (string | null)[] = [null, ...props.folders.map((folder) => folder.id)];
  for (const region of regions) {
    for (const body of readingOrder(bodyList.filter((item) => item.region === region))) ids.push(body.id);
  }
  const before = renderOrder.value;
  if (before.length === ids.length && before.every((id, index) => id === ids[index])) return;
  // Moving a node in the DOM can drop the focus it holds: put it back.
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['todo'] : undefined;
  renderOrder.value = ids;
  if (focused !== undefined) {
    void nextTick(() => {
      const element = bodyEls.get(focused);
      if (element !== undefined && document.activeElement !== element && stage.value?.contains(document.activeElement) !== true) {
        element.focus({ preventScroll: true });
      }
    });
  }
}

/**
 * Bring the bodies in line with what should be drawn. A body that is already
 * there keeps its anchor; a new one goes where it was left, or — never placed
 * — to the seeded field (the first time) or to a free spot (an arrival).
 */
function sync(): void {
  const next = world.value;
  const options = bodyOptions.value;

  // The surface or a dish changed: every anchor keeps its fraction of what holds it.
  if (prevWorld !== null && prevWorld !== next) {
    for (const body of bodyList) {
      if (body.held || body.region === LEAVING_REGION) continue;
      const at = pointOf(fractionOf(body, prevWorld), regionBox(next, body.region));
      body.x = at.x;
      body.y = at.y;
    }
  }

  const keep = new Map<string, Body>();
  const fresh: SeedItem[] = [];
  for (const todo of shown.value) {
    const id = todo.task.id;
    const region = regionOf(todo);
    const size = sizeOf(todo);
    const body = bodies.get(id);
    if (body !== undefined && (body.region === region || body.held)) {
      body.w = size.w;
      body.h = size.h;
      keep.set(id, body);
    } else {
      fresh.push({ id, ...size, region });
    }
  }

  const saved = savedPlaces();
  let seeded = false;
  if (!ready) {
    for (const body of placeBodies(fresh, next, saved, options)) keep.set(body.id, body);
    seeded = fresh.some((item) => !saved.has(item.id));
  } else {
    for (const item of fresh) {
      const place = saved.get(item.id);
      const at = place !== undefined ? pointOf(place, regionBox(next, item.region)) : freeSpot([...keep.values()], next, item, options);
      keep.set(item.id, createBody(item.id, item, at, item.region));
      if (!known.has(item.id)) markArriving(item.id);
      seeded = true;
    }
  }
  for (const id of ghosts.keys()) {
    const ghost = bodies.get(id);
    if (ghost !== undefined) keep.set(id, ghost);
  }

  bodies.clear();
  for (const [id, body] of keep) bodies.set(id, body);
  bodyList = [...bodies.values()];
  for (const id of [...painted.keys()]) if (!bodies.has(id)) painted.delete(id);
  for (const todo of shown.value) known.add(todo.task.id);
  prevWorld = next;

  tidyDishes();
  if (ready && motionOn.value) disturb();
  else settle(bodyList, next, options);
  ready = true;
  refreshOrder();
  paint();
  if (seeded) rememberSoon();
  if (openId.value !== null) placeDetail();
}

/**
 * What is filed is put away: each dish keeps its to-dos in its rows, in the
 * order they were left (top to bottom, left to right). Called whenever what a
 * dish holds, or how wide those things are, has changed.
 */
function tidyDishes(only?: string): void {
  const next = world.value;
  for (const region of next.regions) {
    if (only !== undefined && region.id !== only) continue;
    const inside = readingOrder(bodyList.filter((body) => body.region === region.id && !body.held));
    if (inside.length === 0) continue;
    for (const [id, at] of flowPlaces(inside, region.box, bodyOptions.value)) {
      const body = bodies.get(id);
      if (body === undefined) continue;
      body.x = at.x;
      body.y = at.y;
    }
  }
}

function markArriving(id: string): void {
  arriving.add(id);
  const todo = props.todos.find((item) => item.task.id === id);
  if (todo !== undefined) announce(t('canvas.announce.arrived', { title: todo.task.title }));
  later(() => arriving.delete(id), ARRIVE_MS);
}

// ── Motion: one loop, and when it may run ───────────────────────────────
const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
const tabVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden');
const motionOn = computed(() => !reducedMotion.value && tabVisible.value);
const governor = createGovernor();
const motionLevel = ref<MotionLevel>('full');
const swayReach = computed(() => SWAY_REACH[plan.value.density] * (narrow.value ? NARROW_SWAY : 1));
const insideReach = computed(() => INSIDE_SWAY * (narrow.value ? NARROW_SWAY : 1));

let frame = 0;
let lastFrame = 0;
let clock = 0;
let frames = 0;
/** Anchors are still finding their rest. */
let unsettled = false;
let settleBudgetMs = 0;
let pointer: Point | null = null;
let dragging = false;
const stillIds = new Set<string>();

function refreshStill(): void {
  stillIds.clear();
  for (const id of selection.value.ids) stillIds.add(id);
  if (openId.value !== null) stillIds.add(openId.value);
  if (activeId.value !== null && focusInside.value) stillIds.add(activeId.value);
}

/** Write each capsule's place: its anchor, plus where the current has carried it. */
function paint(): void {
  const reach = motionOn.value && motionLevel.value !== 'still' ? swayReach.value : 0;
  const lean = motionLevel.value === 'full';
  for (const body of bodyList) {
    const element = bodyEls.get(body.id);
    if (element === undefined) continue;
    // What is put away in a folder sits closer together, so it sways less: never across its gap.
    const offset = reach > 0 ? swayAt(body, clock, body.region === null ? reach : Math.min(reach, insideReach.value)) : null;
    const left = body.x - body.w / 2;
    const top = body.y - body.h / 2;
    const text =
      offset === null || (offset.dx === 0 && offset.dy === 0)
        ? `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`
        : `translate3d(${(left + offset.dx).toFixed(2)}px, ${(top + offset.dy).toFixed(2)}px, 0)${lean && body.region === null ? ` rotate(${offset.tilt.toFixed(3)}deg)` : ''}`;
    if (painted.get(body.id) === text) continue;
    painted.set(body.id, text);
    element.style.transform = text;
  }
}

function tick(now: number): void {
  frame = 0;
  const elapsed = lastFrame === 0 ? 16.7 : now - lastFrame;
  lastFrame = now;
  const dt = Math.min(elapsed, 50) / 1000;
  const level = governorTick(governor, elapsed);
  if (level !== motionLevel.value) {
    motionLevel.value = level;
    announce(t(level === 'thin' ? 'canvas.motion.thin' : 'canvas.motion.still'));
  }

  if (unsettled) {
    const moved = relax(bodyList, world.value, { dt, ...bodyOptions.value });
    settleBudgetMs -= elapsed;
    if (!dragging && (moved < REST_EPSILON || settleBudgetMs <= 0)) atRest();
  }
  const swaying = motionOn.value && level !== 'still';
  if (swaying) {
    clock += dt;
    easeDrift(bodyList, { dt, pointer, still: stillIds });
  }
  frames += 1;
  // Thinned: the sway is drawn every other frame; a drag and a settle are drawn on all of them.
  if (level !== 'thin' || frames % 2 === 0 || unsettled || dragging) paint();
  if (swaying || unsettled || dragging) frame = requestAnimationFrame(tick);
}

function wake(): void {
  if (frame !== 0 || typeof requestAnimationFrame !== 'function' || !tabVisible.value) return;
  // Nothing to animate: no frame is asked for (reduced motion with nothing settling or in the hand).
  if (!motionOn.value && !unsettled && !dragging) return;
  lastFrame = 0;
  frame = requestAnimationFrame(tick);
}

function sleep(): void {
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
}

/** Something moved an anchor: let the surface find its rest again (at once, where nothing animates). */
function disturb(): void {
  if (motionOn.value) {
    unsettled = true;
    settleBudgetMs = 4000;
    wake();
    return;
  }
  settle(bodyList, world.value, bodyOptions.value);
  atRest();
  paint();
}

function atRest(): void {
  unsettled = false;
  refreshOrder();
  if (rememberDirty) rememberSoon();
}

function onVisibility(): void {
  tabVisible.value = document.visibilityState !== 'hidden';
}

// Motion switched off (reduced motion, a hidden tab): every body on its anchor, at rest.
watch(motionOn, (on) => {
  if (on) {
    wake();
    return;
  }
  sleep();
  for (const body of bodyList) body.drift = 0;
  settle(bodyList, world.value, bodyOptions.value);
  unsettled = false;
  paint();
});

// ── What is remembered ──────────────────────────────────────────────────
let rememberTimer: ReturnType<typeof setTimeout> | null = null;
let rememberDirty = false;
/** Who moved things: noted at the gesture, because the write comes a moment later. */
let rememberBinding: OwnerBinding | null = null;

function memoryNow(): CanvasMemory {
  const places: Record<string, Fraction> = { ...props.memory.places };
  for (const body of bodyList) {
    if (body.region !== LEAVING_REGION) places[body.id] = fractionOf(body, world.value);
  }
  const folders: Record<string, Fraction> = { ...props.memory.folders };
  for (const [id, place] of liveFolderPlace) folders[id] = place;
  return { ...props.memory, places, folders };
}

function rememberNow(): void {
  if (rememberTimer !== null) clearTimeout(rememberTimer);
  rememberTimer = null;
  rememberDirty = false;
  const binding = rememberBinding ?? captureOwnerBinding();
  rememberBinding = null;
  emit('remember', memoryNow(), binding);
  liveFolderPlace.clear();
}

/** Where things are is written a moment after they stop moving. */
function rememberSoon(): void {
  rememberDirty = true;
  rememberBinding ??= captureOwnerBinding();
  if (rememberTimer !== null) clearTimeout(rememberTimer);
  rememberTimer = setTimeout(() => {
    rememberTimer = null;
    if (unsettled || dragging) return; // atRest writes it
    rememberNow();
  }, 350);
}

// ── Selection, focus, announcements ─────────────────────────────────────
const selection = ref<Selection>(NO_SELECTION);
const activeId = ref<string | null>(null);
const focusInside = ref(false);
const status = ref('');
/**
 * The to-do the one floating detail is open on. Declared here, with the rest
 * of what `refreshStill` reads: the `selected` watcher below runs once while
 * this component is being set up, and a canvas that comes back with to-dos
 * already picked (목록 → 캔버스) reaches `refreshStill` on that first run.
 */
const openId = ref<string | null>(null);

function announce(text: string): void {
  status.value = text;
}

function orderIds(): string[] {
  const live = new Set(shown.value.map((todo) => todo.task.id));
  return renderOrder.value.filter((id) => live.has(id));
}

function setSelection(next: Selection, say = true): void {
  if (next === selection.value) return;
  selection.value = next;
  refreshStill();
  wake();
  emit('update:selected', ordered(next, orderIds()));
  if (say) announce(next.ids.size === 0 ? t('canvas.announce.cleared') : tp('canvas.announce.picked', next.ids.size));
}

watch(
  () => props.selected,
  (ids) => {
    const same = ids.length === selection.value.ids.size && ids.every((id) => selection.value.ids.has(id));
    if (same) return;
    selection.value = { ids: new Set(ids), anchor: ids[0] ?? null };
    refreshStill();
  },
  { immediate: true },
);

const todoById = computed(() => new Map(props.todos.map((todo) => [todo.task.id, todo])));
const pickedTodos = computed(() => ordered(selection.value, orderIds()).map((id) => todoById.value.get(id)).filter((todo) => todo !== undefined));

function focusBody(id: string): void {
  activeId.value = id;
  void nextTick(() => bodyEls.get(id)?.focus({ preventScroll: false }));
}

function onBodyFocus(id: string): void {
  activeId.value = id;
  focusInside.value = true;
  refreshStill();
}

function onFieldFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && (event.currentTarget as Node).contains(next)) return;
  focusInside.value = false;
  refreshStill();
  wake();
}

// ── The floating detail (`openId` is declared with the selection, above) ─
const detailEl = ref<HTMLElement | null>(null);
const detailStyle = ref<Record<string, string>>({ visibility: 'hidden' });
const detailSide = ref<'right' | 'left' | 'below' | 'above'>('right');
const openTodo = computed(() => (openId.value === null ? null : (todoById.value.get(openId.value) ?? null)));

function setDetail(instance: Element | ComponentPublicInstance | null): void {
  const element: unknown = instance !== null && '$el' in instance ? instance.$el : instance;
  detailEl.value = element instanceof HTMLElement ? element : null;
}

/** The part of the surface the window shows, in the surface's own pixels. */
function visibleFrame(): { left: number; top: number; width: number; height: number } {
  const whole = { left: 0, top: 0, width: surface.value.width, height: surface.value.height };
  const element = stage.value;
  if (element === null || typeof window === 'undefined') return whole;
  const rect = element.getBoundingClientRect();
  if (rect.height === 0) return whole;
  const top = Math.max(0, 72 - rect.top);
  const bottom = Math.min(whole.height, window.innerHeight - rect.top - 8);
  return bottom - top < 240 ? whole : { left: 0, top, width: whole.width, height: bottom - top };
}

function placeDetail(): void {
  const id = openId.value;
  const body = id === null ? undefined : bodies.get(id);
  const panel = detailEl.value;
  if (body === undefined || panel === null) return;
  const size = { width: panel.offsetWidth || 320, height: panel.offsetHeight || 320 };
  const placed = placeCard({ left: body.x - body.w / 2, top: body.y - body.h / 2, width: body.w, height: body.h }, size, visibleFrame(), 10);
  detailSide.value = placed.side;
  detailStyle.value = { left: px(placed.left), top: px(placed.top) };
}

function openDetail(id: string): void {
  closePicker();
  detailStyle.value = { visibility: 'hidden' };
  openId.value = id;
  activeId.value = id;
  refreshStill();
  void nextTick(async () => {
    placeDetail();
    await nextTick();
    if (openId.value !== id) return;
    detailEl.value?.focus({ preventScroll: true });
  });
}

function closeDetail(how: { restoreFocus?: boolean } = {}): void {
  const id = openId.value;
  if (id === null) return;
  openId.value = null;
  detailStyle.value = { visibility: 'hidden' };
  refreshStill();
  wake();
  if (how.restoreFocus === true) bodyEls.get(id)?.focus({ preventScroll: true });
}

// The to-do went away (finished, deleted, filed into a folded folder): so does its card.
watch(openTodo, (todo) => {
  if (todo === null && openId.value !== null) closeDetail();
});

function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (stage.value?.contains(target) === true) return; // the surface's own handler decides
  // A dialog laid over the page (a conflict, a confirmation) is not "outside".
  if (target.closest('.dialog, [role="dialog"], [role="alertdialog"], .toast') !== null) return;
  closeDetail();
  closePicker();
}

/**
 * Escape closes what floats wherever the focus is — also when it fell out of
 * the card (the button that had it went away). A dialog laid over the page
 * hears its own Escape first.
 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  if (openId.value === null && picker.value === null) return;
  if (document.querySelector('.dialog[role="dialog"], .dialog[role="alertdialog"]') !== null) return;
  event.preventDefault();
  if (picker.value !== null) closePicker({ restoreFocus: true });
  else closeDetail({ restoreFocus: true });
}

// ── 폴더로 옮기기 without a drag ────────────────────────────────────────
const picker = ref<{ ids: string[]; style: Record<string, string>; returnTo: string | null } | null>(null);

const pickerCurrent = computed<string | null | undefined>(() => {
  const ids = picker.value?.ids ?? [];
  const regions = new Set(ids.map((id) => todoById.value.get(id)?.folderId ?? null));
  if (regions.size !== 1) return undefined;
  return [...regions][0];
});

function openPicker(ids: string[], anchorId: string | null): void {
  if (ids.length === 0 || props.disabled) return;
  closeDetail();
  const body = anchorId === null ? undefined : bodies.get(anchorId);
  const frameBox = visibleFrame();
  const size = { width: 256, height: Math.min(88 + props.folders.length * 40, 360) };
  const placed =
    body === undefined
      ? { left: (frameBox.width - size.width) / 2, top: Math.max(frameBox.top + 12, frameBox.top + frameBox.height - size.height - 84) }
      : placeCard({ left: body.x - body.w / 2, top: body.y - body.h / 2, width: body.w, height: body.h }, size, frameBox, 8);
  picker.value = { ids, style: { left: px(placed.left), top: px(placed.top) }, returnTo: anchorId };
}

function closePicker(how: { restoreFocus?: boolean } = {}): void {
  const current = picker.value;
  if (current === null) return;
  picker.value = null;
  if (how.restoreFocus === true && current.returnTo !== null) bodyEls.get(current.returnTo)?.focus({ preventScroll: true });
}

function tasksOf(ids: readonly string[]): Task[] {
  return ids.map((id) => todoById.value.get(id)?.task).filter((task) => task !== undefined);
}

function onPick(folderId: string | null): void {
  const current = picker.value;
  if (current === null) return;
  closePicker({ restoreFocus: true });
  fileInto(current.ids, folderId, null);
}

function onPickNew(): void {
  const current = picker.value;
  if (current === null) return;
  closePicker();
  props.actions.newFolder(tasksOf(current.ids));
}

/**
 * File to-dos into a folder (or the open water). They go there at once on
 * the surface; if the server says no, they come back.
 */
function fileInto(ids: readonly string[], folderId: string | null, at: Point | null): void {
  if (props.disabled) return;
  const moving = ids.filter((id) => {
    const todo = todoById.value.get(id);
    return todo !== undefined && regionOf(todo) !== folderId;
  });
  if (moving.length === 0) return;
  const tasks = tasksOf(moving);
  const target = regionBox(world.value, folderId);
  moving.forEach((id, index) => {
    pendingRegion.set(id, folderId);
    const body = bodies.get(id);
    if (body === undefined) return;
    body.region = folderId;
    // Dropped: it stays where it was let go. Sent by the keyboard: into the middle, fanned a little.
    if (at === null) {
      body.x = target.left + target.width / 2 + (index - (moving.length - 1) / 2) * 18;
      body.y = target.top + target.height / 2 + (index - (moving.length - 1) / 2) * 12;
    }
  });
  tidyDishes();
  disturb();
  rememberSoon();
  const folder = folderId === null ? undefined : folderById.value.get(folderId);
  void props.actions.file(tasks, folderId).then((movedIds) => {
    const moved = new Set(movedIds);
    // What the server refused comes back to where it was; the rest wait for the list to agree.
    for (const id of moving) if (!moved.has(id)) pendingRegion.delete(id);
    later(() => {
      for (const id of moving) if (pendingRegion.get(id) === folderId) pendingRegion.delete(id);
    }, 4000);
    if (moved.size > 0) {
      announce(
        folder === undefined
          ? tp('canvas.announce.unfiled', moved.size)
          : tp('canvas.announce.filed', moved.size, { title: folder.title }),
      );
    }
    if (moved.size < moving.length) announce(tp('canvas.announce.fileFailed', moving.length - moved.size));
  });
  setSelection(prune(selection.value, new Set([...selection.value.ids].filter((id) => !moving.includes(id)))), false);
}

// ── Finishing: a small, satisfying exit ─────────────────────────────────
/**
 * Finish one to-do. Its body is held from the moment the server is asked, so
 * it is still there to leave when the answer (and the refreshed list, which
 * no longer names it) arrives. Under reduced motion it is simply gone.
 */
async function completeOne(todo: CanvasTodo<Task>): Promise<boolean> {
  const id = todo.task.id;
  if (props.disabled || ghosts.has(id)) return false;
  ghosts.set(id, { todo, state: 'finishing' });
  const ok = await props.actions.complete(todo.task);
  const body = bodies.get(id);
  if (!ok || body === undefined || reducedMotion.value) {
    ghosts.delete(id);
    if (ok) dropBody(id);
    return ok;
  }
  if (openId.value === id) closeDetail();
  body.region = LEAVING_REGION;
  body.held = true;
  ghosts.set(id, { todo, state: 'leaving' });
  later(() => {
    ghosts.delete(id);
    dropBody(id);
  }, LEAVE_MS);
  return true;
}

function dropBody(id: string): void {
  if (todoById.value.has(id)) return; // still listed (the refetch has not come): sync decides
  bodies.delete(id);
  bodyList = [...bodies.values()];
  painted.delete(id);
}

async function completeTodos(ids: readonly string[]): Promise<void> {
  if (props.disabled) return;
  let done = 0;
  let last = '';
  for (const id of ids) {
    const todo = todoById.value.get(id);
    if (todo === undefined) continue;
    if (!(await completeOne(todo))) continue;
    done += 1;
    last = todo.task.title;
  }
  if (done === 1) announce(t('canvas.announce.completed', { title: last }));
  else if (done > 1) announce(tp('canvas.announce.completedMany', done));
  setSelection(prune(selection.value, new Set([...selection.value.ids].filter((id) => !ids.includes(id)))), false);
}

/** What the detail card may ask for: the same requests, with the surface's own answer to two of them. */
const detailActions = computed<CanvasActions>(() => ({
  ...props.actions,
  complete: async (task) => {
    const todo = todoById.value.get(task.id);
    if (todo === undefined) return false;
    const ok = await completeOne(todo);
    if (ok) announce(t('canvas.announce.completed', { title: task.title }));
    return ok;
  },
  file: (tasks, folderId) => {
    const ids = tasks.map((task) => task.id);
    fileInto(ids, folderId, null);
    return Promise.resolve(ids);
  },
}));

// ── The pointer: press, drag, lasso, a dish in the hand ─────────────────
type Gesture =
  | { kind: 'press' | 'drag'; pointerId: number; id: string; start: Point; ids: string[]; grab: Map<string, Point>; armed: boolean; modifier: boolean }
  | { kind: 'lasso'; pointerId: number; start: Point; add: boolean; moved: boolean }
  | { kind: 'dish'; pointerId: number; id: string; start: Point; grab: Point; armed: boolean; moved: boolean };

let gesture: Gesture | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
const lassoBox = ref<{ left: number; top: number; width: number; height: number } | null>(null);
/** While a to-do is in the hand: the folder it is over (null: the open water); undefined otherwise. */
const dropFolder = ref<string | null | undefined>(undefined);
const heldIds = reactive(new Set<string>());
const DRAG_SLOP = 5;
const HOLD_MS = 280;

function stagePoint(event: { clientX: number; clientY: number }): Point {
  const rect = stage.value?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function clearHold(): void {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
}

function capture(event: PointerEvent): void {
  try {
    stage.value?.setPointerCapture?.(event.pointerId);
  } catch {
    // A pointer that is already gone cannot be captured; the gesture ends on its own.
  }
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || gesture !== null) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('[data-pond-ignore]') !== null) return;
  const point = stagePoint(event);
  const touch = event.pointerType === 'touch';

  const todoEl = target.closest<HTMLElement>('[data-todo]');
  if (todoEl !== null) {
    const id = todoEl.dataset['todo'] as string;
    if (ghosts.has(id)) return;
    gesture = {
      kind: 'press',
      pointerId: event.pointerId,
      id,
      start: point,
      ids: [],
      grab: new Map(),
      armed: !touch,
      modifier: event.shiftKey || event.ctrlKey || event.metaKey,
    };
    // A finger scrolls the page unless it rests on the to-do first.
    if (touch) holdTimer = setTimeout(() => armPress(id), HOLD_MS);
    else capture(event);
    return;
  }

  if (target.closest('button, a, input, select, textarea, [role="menu"]') !== null) return;
  const grip = target.closest<HTMLElement>('[data-folder-grip]');
  if (grip !== null) {
    const id = grip.dataset['folderGrip'] as string;
    const box = folderBoxes.value.find((item) => item.id === id)?.box;
    if (box === undefined) return;
    gesture = {
      kind: 'dish',
      pointerId: event.pointerId,
      id,
      start: point,
      grab: { x: point.x - (box.left + box.width / 2), y: point.y - (box.top + box.height / 2) },
      armed: !touch,
      moved: false,
    };
    if (touch) holdTimer = setTimeout(() => armPress(id), HOLD_MS);
    else capture(event);
    return;
  }

  // The water (and a dish's own floor): a lasso with a mouse or a pen; a finger scrolls.
  closeDetail();
  closePicker();
  if (touch) {
    if (selection.value.ids.size > 0) setSelection(NO_SELECTION);
    return;
  }
  gesture = { kind: 'lasso', pointerId: event.pointerId, start: point, add: event.shiftKey, moved: false };
  capture(event);
}

function armPress(id: string): void {
  holdTimer = null;
  if (gesture === null || gesture.kind === 'lasso' || gesture.id !== id) return;
  gesture.armed = true;
  holdScroll(true);
  if (gesture.kind === 'press') startDrag(gesture, gesture.start);
}

function startDrag(press: Extract<Gesture, { kind: 'press' | 'drag' }>, point: Point): void {
  closeDetail();
  closePicker();
  const picked = selection.value.ids;
  press.ids = picked.has(press.id) && picked.size > 1 ? [...picked].filter((id) => bodies.has(id)) : [press.id];
  for (const id of press.ids) {
    const body = bodies.get(id);
    if (body === undefined) continue;
    body.held = true;
    press.grab.set(id, { x: body.x - point.x, y: body.y - point.y });
    heldIds.add(id);
  }
  press.kind = 'drag';
  dragging = true;
  dropFolder.value = folderAt(point, folderBoxes.value);
  wake();
}

function onPointerMove(event: PointerEvent): void {
  const point = stagePoint(event);
  if (event.pointerType === 'mouse') {
    pointer = point;
    wake();
  }
  const current = gesture;
  if (current === null || current.pointerId !== event.pointerId) return;
  const far = Math.hypot(point.x - current.start.x, point.y - current.start.y) > DRAG_SLOP;

  if (current.kind === 'press') {
    if (!far) return;
    if (!current.armed) {
      // The finger moved before the hold: it is a scroll, not a drag.
      clearHold();
      gesture = null;
      return;
    }
    startDrag(current, current.start);
  }
  if (current.kind === 'drag') {
    for (const id of current.ids) {
      const body = bodies.get(id);
      const grab = current.grab.get(id);
      if (body === undefined || grab === undefined) continue;
      body.x = Math.max(body.w / 2, Math.min(point.x + grab.x, surface.value.width - body.w / 2));
      body.y = Math.max(body.h / 2, Math.min(point.y + grab.y, surface.value.height - body.h / 2));
    }
    dropFolder.value = folderAt(point, folderBoxes.value);
    unsettled = true;
    settleBudgetMs = 4000;
    if (!motionOn.value) {
      // Nothing animates: what is under the hand gives way at once.
      settle(bodyList, world.value, bodyOptions.value, 40);
      paint();
    } else wake();
    return;
  }
  if (current.kind === 'lasso') {
    if (!far && !current.moved) return;
    current.moved = true;
    lassoBox.value = {
      left: Math.min(current.start.x, point.x),
      top: Math.min(current.start.y, point.y),
      width: Math.abs(point.x - current.start.x),
      height: Math.abs(point.y - current.start.y),
    };
    return;
  }
  if (current.kind === 'dish') {
    if (!current.armed) {
      if (far) {
        clearHold();
        gesture = null;
      }
      return;
    }
    if (!far && !current.moved) return;
    current.moved = true;
    const clamp = (value: number): number => Math.max(0, Math.min(1, value));
    liveFolderPlace.set(current.id, {
      u: clamp((point.x - current.grab.x) / surface.value.width),
      v: clamp((point.y - current.grab.y) / surface.value.height),
    });
  }
}

function onPointerUp(event: PointerEvent): void {
  const current = gesture;
  if (current === null || current.pointerId !== event.pointerId) return;
  clearHold();
  holdScroll(false);
  gesture = null;
  const point = stagePoint(event);

  if (current.kind === 'press') {
    // A click. With Shift, Ctrl or ⌘ it picks; plain, it opens the one detail.
    if (current.modifier) {
      activeId.value = current.id;
      setSelection(toggle(selection.value, current.id));
    } else if (openId.value === current.id) closeDetail({ restoreFocus: true });
    else openDetail(current.id);
    return;
  }
  if (current.kind === 'drag') {
    endDrag(current, point, false);
    return;
  }
  if (current.kind === 'lasso') {
    lassoBox.value = null;
    if (current.moved) setSelection(lasso(selection.value, bodiesIn(current.start, point, liveBodies()), current.add));
    else if (selection.value.ids.size > 0) setSelection(NO_SELECTION);
    return;
  }
  if (current.kind === 'dish' && current.moved) rememberNow();
}

function onPointerCancel(event: PointerEvent): void {
  const current = gesture;
  if (current === null || current.pointerId !== event.pointerId) return;
  clearHold();
  holdScroll(false);
  gesture = null;
  lassoBox.value = null;
  if (current.kind === 'drag') endDrag(current, current.start, true);
  if (current.kind === 'dish') liveFolderPlace.delete(current.id);
}

function onPointerLeave(): void {
  pointer = null;
}

function liveBodies(): Body[] {
  return bodyList.filter((body) => body.region !== LEAVING_REGION);
}

function endDrag(drag: Extract<Gesture, { kind: 'press' | 'drag' }>, point: Point, cancelled: boolean): void {
  dragging = false;
  const target = folderAt(point, folderBoxes.value);
  dropFolder.value = undefined;
  for (const id of drag.ids) {
    const body = bodies.get(id);
    if (body !== undefined) body.held = false;
    heldIds.delete(id);
  }
  if (!cancelled && !props.disabled) fileInto(drag.ids, target, point);
  // Not filed (the same water, offline, cancelled): each body is drawn back into what holds it.
  // Dropped in a dish, it takes its place in the dish's rows.
  tidyDishes();
  disturb();
  rememberSoon();
}

/**
 * A finger that holds a to-do must not scroll the page under it. The listener
 * is there only while something is held, so an ordinary scroll is never made
 * to wait for this script.
 */
function onTouchMove(event: TouchEvent): void {
  if (event.cancelable) event.preventDefault();
}

function holdScroll(on: boolean): void {
  if (on) stage.value?.addEventListener('touchmove', onTouchMove, { passive: false });
  else stage.value?.removeEventListener('touchmove', onTouchMove);
}

// ── The keyboard: a list ────────────────────────────────────────────────
const ARROWS: Readonly<Record<string, Direction>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const NUDGE = 24;

function onFieldKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.dataset['todo'] === undefined) return;
  const id = target.dataset['todo'];
  const direction = ARROWS[event.key];
  const live = liveBodies();

  if (direction !== undefined) {
    event.preventDefault();
    if (event.altKey) {
      nudge(id, direction, event.shiftKey ? NUDGE * 4 : NUDGE);
      return;
    }
    const next = neighbour(live, id, direction);
    if (next === null) return;
    if (event.shiftKey) {
      const base = selection.value.ids.size === 0 ? { ids: new Set([id]), anchor: id } : selection.value;
      setSelection(extendTo(base, next, orderIds()));
    }
    focusBody(next);
    return;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const edge = edgeOf(live, event.key === 'Home' ? 'first' : 'last');
    if (edge !== null) focusBody(edge);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (openId.value === id) closeDetail({ restoreFocus: true });
    else openDetail(id);
    return;
  }
  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    setSelection(toggle(selection.value, id));
    return;
  }
  if (event.key === 'Escape') {
    if (openId.value !== null) {
      event.preventDefault();
      closeDetail({ restoreFocus: true });
    } else if (selection.value.ids.size > 0) {
      event.preventDefault();
      setSelection(NO_SELECTION);
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    setSelection(all(orderIds()));
    return;
  }
  if (event.key.toLowerCase() === 'v' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    const ids = selection.value.ids.has(id) ? ordered(selection.value, orderIds()) : [id];
    openPicker(ids, id);
  }
}

/** Alt+arrow: the to-do moves, and where it lands is remembered. */
function nudge(id: string, direction: Direction, by: number): void {
  const body = bodies.get(id);
  if (body === undefined) return;
  if (direction === 'left') body.x -= by;
  else if (direction === 'right') body.x += by;
  else if (direction === 'up') body.y -= by;
  else body.y += by;
  // It leads: what it lands on gives way, then it is let go.
  body.held = true;
  settle(bodyList, world.value, bodyOptions.value, 60);
  body.held = false;
  if (body.region !== null) tidyDishes(body.region);
  disturb();
  paint();
  rememberSoon();
  announce(t('canvas.announce.moved'));
}

// ── Folders: the dishes ─────────────────────────────────────────────────
const renamingId = ref<string | null>(null);
const renameDraft = ref('');
const renameBusy = ref(false);
const menuFor = ref<string | null>(null);

function titleOf(id: string): string {
  return folderById.value.get(id)?.title ?? '';
}

function countOf(id: string): number {
  return byRegion.value.get(id)?.length ?? 0;
}

function folderPlanLink(id: string): { path: string; query: { taskIds: string } } | null {
  const ids = (byRegion.value.get(id) ?? []).map((todo) => todo.task.id);
  return ids.length === 0 ? null : { path: '/plan/schedule', query: { taskIds: ids.join(',') } };
}

function toggleFold(id: string): void {
  menuFor.value = null;
  const next = new Set(folded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  if (rememberTimer !== null) clearTimeout(rememberTimer);
  rememberTimer = null;
  rememberBinding = null;
  rememberDirty = false;
  emit('remember', { ...memoryNow(), folded: [...next] }, captureOwnerBinding());
}

function startRename(id: string): void {
  if (props.disabled) return;
  menuFor.value = null;
  renamingId.value = id;
  renameDraft.value = titleOf(id);
  void nextTick(() => {
    const input = stage.value?.querySelector<HTMLInputElement>(`[data-folder-rename="${id}"]`);
    input?.focus();
    input?.select();
  });
}

function cancelRename(): void {
  const id = renamingId.value;
  renamingId.value = null;
  if (id !== null) void nextTick(() => stage.value?.querySelector<HTMLElement>(`[data-folder-name="${id}"]`)?.focus());
}

async function commitRename(): Promise<void> {
  const id = renamingId.value;
  const folder = id === null ? undefined : folderById.value.get(id);
  if (folder === undefined || renameBusy.value) return;
  const title = renameDraft.value.trim();
  if (title.length === 0 || title === folder.title) {
    cancelRename();
    return;
  }
  renameBusy.value = true;
  try {
    if (await props.actions.renameFolder(folder, title)) cancelRename();
  } finally {
    renameBusy.value = false;
  }
}

function onMenuKeydown(event: KeyboardEvent, id: string): void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  menuFor.value = null;
  stage.value?.querySelector<HTMLElement>(`[data-folder-menu-button="${id}"]`)?.focus();
}

function onMenuFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && (event.currentTarget as Node).contains(next)) return;
  menuFor.value = null;
}

function removeFolder(id: string): void {
  menuFor.value = null;
  const folder = folderById.value.get(id);
  if (folder !== undefined) props.actions.removeFolder(folder);
}

// ── What is drawn, group by group ───────────────────────────────────────
const groups = computed(() => {
  const index = new Map(renderOrder.value.map((id, position) => [id, position]));
  const everything = [...shown.value];
  const live = new Set(everything.map((todo) => todo.task.id));
  const ghostRegion = new Map<string, string | null>();
  for (const [id, ghost] of ghosts) {
    if (live.has(id)) continue;
    everything.push(ghost.todo);
    ghostRegion.set(id, ghost.todo.folderId);
  }
  const inRegion = (region: string | null): CanvasTodo<Task>[] =>
    everything
      .filter((todo) => (ghostRegion.has(todo.task.id) ? ghostRegion.get(todo.task.id) : regionOf(todo)) === region)
      .sort((a, b) => (index.get(a.task.id) ?? 1e9) - (index.get(b.task.id) ?? 1e9));
  return [
    { key: 'inbox', label: t('canvas.inbox'), todos: inRegion(null) },
    ...props.folders.map((folder) => ({ key: folder.id, label: t('canvas.folderGroup', { title: folder.title }), todos: inRegion(folder.id) })),
  ].filter((group) => group.todos.length > 0);
});

/** The one tab stop of the list: the to-do last in focus, else the first. */
const tabStop = computed(() => {
  const live = new Set(shown.value.map((todo) => todo.task.id));
  if (activeId.value !== null && live.has(activeId.value)) return activeId.value;
  return renderOrder.value.find((id) => live.has(id)) ?? shown.value[0]?.task.id ?? null;
});

function setBodyEl(id: string, instance: Element | ComponentPublicInstance | null): void {
  if (instance instanceof HTMLElement) {
    if (bodyEls.get(id) !== instance) {
      bodyEls.set(id, instance);
      painted.delete(id);
    }
  } else bodyEls.delete(id);
}

function stateOf(id: string): string | undefined {
  if (ghosts.get(id)?.state === 'leaving') return 'leaving';
  if (heldIds.has(id)) return 'held';
  if (arriving.has(id)) return 'arriving';
  return undefined;
}

// ── Life ────────────────────────────────────────────────────────────────
let resizeObserver: ResizeObserver | null = null;

watch([shown, world, () => plan.value.density], () => sync(), { flush: 'post' });

// What is no longer on the surface is no longer picked.
watch(shown, (list) => {
  const live = new Set(list.map((todo) => todo.task.id));
  setSelection(prune(selection.value, live), false);
});

onMounted(() => {
  measureStage();
  sync();
  // Before the first frame is shown: the capsules as wide as they really are.
  void nextTick(() => {
    if (measureBodies()) {
      tidyDishes();
      settle(bodyList, world.value, bodyOptions.value);
      refreshOrder();
    }
    paint();
    wake();
  });
  if (typeof ResizeObserver === 'function' && stage.value !== null) {
    resizeObserver = new ResizeObserver(() => measureStage());
    resizeObserver.observe(stage.value);
  }
  window.addEventListener('resize', measureStage);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeydown);
});

// A new or renamed to-do is measured once it has been drawn.
watch(
  shown,
  () => {
    void nextTick(() => {
      if (!measureBodies()) return;
      tidyDishes();
      disturb();
      paint();
    });
  },
  { flush: 'post' },
);

onBeforeUnmount(() => {
  sleep();
  clearHold();
  if (rememberTimer !== null || rememberDirty) rememberNow();
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  resizeObserver?.disconnect();
  window.removeEventListener('resize', measureStage);
  document.removeEventListener('visibilitychange', onVisibility);
  document.removeEventListener('pointerdown', onDocumentPointerDown);
  document.removeEventListener('keydown', onDocumentKeydown);
  holdScroll(false);
});

</script>

<template>
  <div
    ref="stage"
    class="pond"
    :class="{ 'pond--narrow': narrow, 'pond--dragging': dropFolder !== undefined }"
    :style="{ height: px(surface.height), '--pond-water': px(waterBox.width), '--pond-water-height': px(waterBox.height) }"
    :data-density="plan.density"
    :data-motion="motionOn ? motionLevel : 'still'"
    data-todo-canvas
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @pointerleave="onPointerLeave"
  >
    <p class="visually-hidden" role="status" aria-live="polite" data-canvas-status>{{ status }}</p>

    <!-- The to-dos: one listbox, a group a water, an option a to-do. First in the DOM, so the keyboard reaches them first. -->
    <div
      v-if="groups.length > 0"
      class="pond-field"
      role="listbox"
      aria-multiselectable="true"
      :aria-label="tp('canvas.surface', props.todos.length)"
      aria-describedby="pond-help"
      data-canvas-field
      @keydown="onFieldKeydown"
      @focusout="onFieldFocusOut"
    >
      <div v-for="group in groups" :key="group.key" class="pond-group" role="group" :aria-label="group.label" :data-canvas-group="group.key">
        <div
          v-for="todo in group.todos"
          :id="`pond-todo-${todo.task.id}`"
          :key="todo.task.id"
          :ref="(element) => setBodyEl(todo.task.id, element)"
          class="pond-todo"
          role="option"
          :tabindex="tabStop === todo.task.id ? 0 : -1"
          :aria-selected="selection.ids.has(todo.task.id) ? 'true' : 'false'"
          :aria-label="nameOf(todo)"
          :data-todo="todo.task.id"
          :data-depth="todo.depth"
          :data-status="todo.task.status"
          :data-folder="group.key"
          :data-filed="group.key === 'inbox' ? undefined : 'true'"
          :data-state="stateOf(todo.task.id)"
          :data-overdue="todo.overdue ? 'true' : undefined"
          :data-open="openId === todo.task.id ? 'true' : undefined"
          @focus="onBodyFocus(todo.task.id)"
        >
          <span class="pond-capsule glass glass--still glass--flat">
            <span class="pond-mark" aria-hidden="true"><UiIcon name="check" :size="11" /></span>
            <span class="pond-title">{{ todo.task.title }}</span>
            <span v-if="todo.planned" class="pond-planned" aria-hidden="true" data-todo-planned></span>
            <span v-if="todo.due" class="pond-due tabular" :data-due="dueToneOf(todo.due)" aria-hidden="true" data-todo-due>{{ dueText(todo) }}</span>
          </span>
        </div>
      </div>
    </div>
    <p id="pond-help" class="visually-hidden">{{ t('canvas.surfaceHelp') }}</p>

    <!-- The folders: dishes under the to-dos. -->
    <section
      v-for="box in folderBoxes"
      :key="box.id"
      class="pond-folder glass glass--still glass--flat"
      :class="{ 'pond-folder--folded': box.collapsed, 'pond-folder--drop': dropFolder === box.id, 'pond-folder--menu': menuFor === box.id }"
      :style="{ left: px(box.box.left), top: px(box.box.top), width: px(box.box.width), height: px(box.box.height) }"
      :aria-label="t('canvas.folder.label', { title: titleOf(box.id) })"
      :data-folder-dish="box.id"
      :data-hue="projectHue(box.id)"
      :data-folded="box.collapsed ? 'true' : undefined"
    >
      <button
        v-if="box.collapsed"
        type="button"
        class="pond-folder-unfold"
        :aria-label="t('canvas.folder.unfoldAria', { title: titleOf(box.id), count: countOf(box.id) })"
        :data-folder-unfold="box.id"
        @click="toggleFold(box.id)"
      >
        <span class="pond-dot" :data-hue="projectHue(box.id)" aria-hidden="true"></span>
        <span class="pond-folder-name-text">{{ titleOf(box.id) }}</span>
        <span class="pond-folder-count tabular" aria-hidden="true">{{ countOf(box.id) }}</span>
      </button>
      <template v-else>
        <header class="pond-folder-head" :data-folder-grip="box.id">
          <span class="pond-dot" :data-hue="projectHue(box.id)" aria-hidden="true"></span>
          <form v-if="renamingId === box.id" class="pond-folder-rename" @submit.prevent="commitRename">
            <input
              v-model="renameDraft"
              type="text"
              maxlength="200"
              class="pond-folder-rename-input"
              :aria-label="t('canvas.folder.name')"
              :disabled="renameBusy"
              :data-folder-rename="box.id"
              @keydown.esc.prevent.stop="cancelRename"
              @blur="commitRename"
            />
          </form>
          <h2 v-else class="pond-folder-title">
            <button
              type="button"
              class="pond-folder-name"
              :aria-label="t('canvas.folder.renameAria', { title: titleOf(box.id) })"
              :disabled="disabled"
              :data-folder-name="box.id"
              @click="startRename(box.id)"
            >
              <span class="pond-folder-name-text">{{ titleOf(box.id) }}</span>
            </button>
          </h2>
          <span class="pond-folder-count tabular" data-folder-count>
            <span aria-hidden="true">{{ countOf(box.id) }}</span>
            <span class="visually-hidden">{{ tp('canvas.folder.count', countOf(box.id)) }}</span>
          </span>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm pond-folder-button"
            :aria-label="t('canvas.folder.foldAria', { title: titleOf(box.id) })"
            :data-folder-fold="box.id"
            @click="toggleFold(box.id)"
          >
            <UiIcon name="collapse" :size="16" />
          </button>
          <div class="pond-folder-menu-wrap" @focusout="onMenuFocusOut" @keydown="onMenuKeydown($event, box.id)">
            <button
              type="button"
              class="btn btn--ghost btn--icon btn--sm pond-folder-button"
              aria-haspopup="menu"
              :aria-expanded="menuFor === box.id ? 'true' : 'false'"
              :aria-label="t('canvas.folder.menu', { title: titleOf(box.id) })"
              :data-folder-menu-button="box.id"
              @click="menuFor = menuFor === box.id ? null : box.id"
            >
              <UiIcon name="more" :size="16" />
            </button>
            <div v-if="menuFor === box.id" class="menu glass pond-folder-menu" role="menu" :data-folder-menu="box.id">
              <RouterLink
                v-if="folderPlanLink(box.id)"
                :to="folderPlanLink(box.id) ?? ''"
                role="menuitem"
                class="btn btn--ghost menu-item"
                data-folder-plan
              >
                <UiIcon name="plan" :size="16" class="btn-icon" />{{ t('canvas.folder.toPlan') }}
              </RouterLink>
              <button type="button" role="menuitem" class="btn btn--ghost menu-item" :disabled="disabled" data-folder-rename-item @click="startRename(box.id)">
                <UiIcon name="edit" :size="16" class="btn-icon" />{{ t('canvas.folder.rename') }}
              </button>
              <RouterLink :to="`/projects/${box.id}`" role="menuitem" class="btn btn--ghost menu-item" data-folder-open>
                <UiIcon name="open" :size="16" class="btn-icon" />{{ t('canvas.folder.openPage') }}
              </RouterLink>
              <button
                type="button"
                role="menuitem"
                class="btn btn--danger-ghost menu-item"
                :disabled="disabled"
                data-folder-remove
                @click="removeFolder(box.id)"
              >
                <UiIcon name="trash" :size="16" class="btn-icon" />{{ t('canvas.folder.remove') }}
              </button>
            </div>
          </div>
        </header>
        <p v-if="box.hidden > 0" class="pond-folder-more tabular" data-folder-hidden>
          <span aria-hidden="true">{{ tp('canvas.folder.hidden', box.hidden) }}</span>
          <span class="visually-hidden">{{ tp('canvas.folder.hiddenAria', box.hidden) }}</span>
        </p>
      </template>
    </section>

    <div v-if="lassoBox" class="pond-lasso" :style="{ left: px(lassoBox.left), top: px(lassoBox.top), width: px(lassoBox.width), height: px(lassoBox.height) }" aria-hidden="true" data-canvas-lasso></div>

    <!-- An empty surface leads back a stage: the capture bar is the invitation. -->
    <UiEmptyState v-if="props.todos.length === 0" icon="inbox" class="pond-empty" :title="t('canvas.empty.title')" data-pond-ignore data-canvas-empty>
      {{ t('canvas.empty.body') }}
      <template #actions>
        <UiButton variant="primary" icon="plus" data-canvas-capture @click="emit('capture')">{{ t('canvas.empty.action') }}</UiButton>
      </template>
    </UiEmptyState>

    <TodoDetailCard
      v-if="openTodo"
      :ref="setDetail"
      :key="openTodo.task.id"
      :todo="openTodo"
      :folders="folders"
      :time-zone="timeZone"
      :disabled="disabled"
      :side="detailSide"
      :actions="detailActions"
      :style="detailStyle"
      @close="(restoreFocus) => closeDetail({ restoreFocus })"
    />

    <FolderPicker
      v-if="picker"
      :folders="folders"
      :current="pickerCurrent"
      :style="picker.style"
      @pick="onPick"
      @create="onPickNew"
      @close="(restoreFocus) => closePicker({ restoreFocus })"
    />

    <!-- What stays in reach while the surface scrolls: the selection, and the rest of a long list. -->
    <div class="pond-foot" data-pond-ignore>
      <div v-if="selection.ids.size > 0" class="pond-selection glass glass--still glass--low" role="group" :aria-label="t('canvas.selection.label')" data-canvas-selection>
        <p class="pond-selection-count tabular" data-canvas-selection-count>{{ tp('canvas.selection.count', selection.ids.size) }}</p>
        <UiButton size="sm" icon="projects" :disabled="disabled" data-canvas-selection-move @click="openPicker(ordered(selection, orderIds()), null)">
          {{ t('canvas.selection.move') }}
        </UiButton>
        <UiButton size="sm" icon="check" :disabled="disabled" data-canvas-selection-complete @click="completeTodos(ordered(selection, orderIds()))">
          {{ t('canvas.selection.complete') }}
        </UiButton>
        <UiButton size="sm" variant="ghost" data-canvas-selection-clear @click="setSelection(NO_SELECTION)">{{ t('canvas.selection.clear') }}</UiButton>
      </div>
      <p v-else-if="plan.hidden > 0" class="pond-more glass glass--still glass--low" data-canvas-more>
        <span class="pond-more-note">{{ t('canvas.moreHelp') }}</span>
        <UiButton size="sm" data-canvas-more-button @click="expanded = true">{{ tp('canvas.more', plan.hidden) }}</UiButton>
      </p>
      <p v-else-if="expanded" class="pond-more glass glass--still glass--low" data-canvas-less>
        <UiButton size="sm" variant="ghost" data-canvas-less-button @click="expanded = false">{{ t('canvas.less') }}</UiButton>
      </p>
    </div>
  </div>
</template>
