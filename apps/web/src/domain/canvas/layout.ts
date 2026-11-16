import { hashSeed, seededRandom } from './random';
import { createBody, settle, type Body, type Box, type Point, type Region, type World } from './sim';

/**
 * Where things are on the 할 일 canvas (HOLO-05): the surface's size and how
 * much it shows (the density rule), the folders' dishes, and the anchors of
 * the to-dos — from where the owner left them, or seeded when they have never
 * been placed. Pure: the same input gives the same surface.
 */

/** A remembered place: the centre as a fraction of what holds it (the surface, or a folder's inside). */
export interface Fraction {
  readonly u: number;
  readonly v: number;
}

// ── The density rule ────────────────────────────────────────────────────
export type Density = 'airy' | 'compact';

/** Surface (px²) one to-do takes with the calm around it, per density. */
export const FOOTPRINT: Readonly<Record<Density, number>> = { airy: 22_000, compact: 14_500 };
/** The least distance between two to-dos at rest, per density. */
export const BODY_GAP: Readonly<Record<Density, number>> = { airy: 22, compact: 12 };
/** How far a to-do sways from its anchor (px), per density: always less than half the gap. */
export const SWAY_REACH: Readonly<Record<Density, number>> = { airy: 7, compact: 4 };
/** A narrow surface sways this much of that: gentler on a phone. */
export const NARROW_SWAY = 0.6;
/** The least distance between a to-do and the edge of what holds it. */
export const BODY_PAD = 14;
/** Inside a folder things are put away: the compact size, closer together. */
export const INSIDE_GAP = 10;
export const INSIDE_PAD = 10;
/** …and it sways less, without the lean: never across that gap. */
export const INSIDE_SWAY = 3;
/** On a narrow surface wide capsules pack worse: each takes this much more room. */
const NARROW_FOOTPRINT = 1.3;
/** The surface may grow to this many times the window's room before anything is held back. */
export const SURFACE_GROWTH = 2;
/** A narrow surface scrolls anyway: it may grow to this many windows. */
export const NARROW_GROWTH = 3;
/** Never more bodies than this on the open water, however long the surface. */
export const SURFACE_HARD_CAP = 300;
/** Room a dish takes on the surface beyond its own box. */
const DISH_AIR = 1.2;

export interface DensityInput {
  /** To-dos on the open water (not those in folders). */
  readonly count: number;
  readonly width: number;
  /** The height the window leaves for the surface. */
  readonly baseHeight: number;
  /** The folders' dishes, in px². */
  readonly dishArea: number;
  /** The owner asked to see them all ("N개 더"). */
  readonly expanded: boolean;
  /** How many windows the surface may grow to (default SURFACE_GROWTH; a phone, which scrolls anyway, takes more). */
  readonly growth?: number;
}

export interface DensityPlan {
  readonly density: Density;
  /** How many of the open water's to-dos are drawn (the most urgent first). */
  readonly shown: number;
  /** The rest, gathered into one "N개 더". */
  readonly hidden: number;
  readonly height: number;
}

/**
 * How many to-dos the open water shows, how large, and how long the surface is.
 *
 * 1. They all fit with air around them: full size, the window's own height.
 * 2. They fit closer together: the compact size, the same height.
 * 3. They need more room: the surface grows, up to SURFACE_GROWTH windows.
 * 4. Still more: the most urgent are shown and the rest become "N개 더". Asking
 *    for them all (`expanded`) lets the surface grow as long as it must, up to
 *    SURFACE_HARD_CAP bodies.
 */
export function planDensity(input: DensityInput): DensityPlan {
  const count = Math.max(0, Math.floor(input.count));
  const width = Math.max(1, input.width);
  const baseHeight = Math.max(1, input.baseHeight);
  const dishes = Math.max(0, input.dishArea) * DISH_AIR;
  const room = Math.max(0, width * baseHeight - dishes);
  const airy = footprintOf('airy', width);
  const compact = footprintOf('compact', width);

  if (count * airy <= room) return { density: 'airy', shown: count, hidden: 0, height: baseHeight };
  if (count * compact <= room) return { density: 'compact', shown: count, hidden: 0, height: baseHeight };

  const heightFor = (bodies: number): number => Math.ceil((bodies * compact + dishes) / width);
  const grown = baseHeight * Math.max(1, input.growth ?? SURFACE_GROWTH);
  if (heightFor(count) <= grown) return { density: 'compact', shown: count, hidden: 0, height: heightFor(count) };

  if (input.expanded) {
    const shown = Math.min(count, SURFACE_HARD_CAP);
    return { density: 'compact', shown, hidden: count - shown, height: Math.max(grown, heightFor(shown)) };
  }
  const shown = Math.max(0, Math.min(count, Math.floor((width * grown - dishes) / compact)));
  return { density: 'compact', shown, hidden: count - shown, height: grown };
}

/** The room one to-do takes on a surface of `width`. */
export function footprintOf(density: Density, width: number): number {
  return FOOTPRINT[density] * (width < NARROW_SURFACE ? NARROW_FOOTPRINT : 1);
}

// ── Sizes ───────────────────────────────────────────────────────────────
/** How near a to-do is drawn: 0 is due now (largest, brightest), 2 is far or undated. */
export type Depth = 0 | 1 | 2;

export const DAY_MS = 86_400_000;
/** Due within this long (or past): the nearest depth. */
export const NEAR_MS = 2 * DAY_MS;
/** Due within this long: the middle depth. */
export const SOON_MS = 7 * DAY_MS;

/** A closer deadline is drawn nearer; no deadline is the far depth. */
export function depthOf(dueAt: string | undefined, nowMs: number): Depth {
  if (dueAt === undefined) return 2;
  const left = Date.parse(dueAt) - nowMs;
  if (!Number.isFinite(left)) return 2;
  if (left <= NEAR_MS) return 0;
  return left <= SOON_MS ? 1 : 2;
}

/**
 * The order of urgency: past and nearest deadlines first, then those without
 * one, newest first. It decides who is nearest the middle when a surface is
 * seeded and who is shown when not all are.
 */
export function byUrgency<T extends { readonly id: string; readonly dueAt?: string | undefined; readonly createdAt: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) => {
    const a = left.dueAt === undefined ? Infinity : Date.parse(left.dueAt);
    const b = right.dueAt === undefined ? Infinity : Date.parse(right.dueAt);
    if (a !== b) return a < b ? -1 : 1;
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * A to-do's capsule by density and depth, as styles/screens/23-canvas.css
 * draws it: its height, its type size and the most its title takes (px).
 */
const CAPSULE: Readonly<Record<Density, readonly { readonly h: number; readonly em: number; readonly title: number }[]>> = {
  airy: [
    { h: 46, em: 16, title: 216 },
    { h: 42, em: 14, title: 216 },
    { h: 38, em: 14, title: 216 },
  ],
  compact: [
    { h: 38, em: 14, title: 168 },
    { h: 36, em: 13, title: 168 },
    { h: 34, em: 13, title: 168 },
  ],
};
/** Left padding, the mark, the gap after it, right padding and the two edges. */
const CAPSULE_CHROME = 12 + 18 + 8 + 16 + 2;

/** A Hangul syllable or other wide glyph takes a full em; Latin about half. */
function textWidth(text: string, em: number): number {
  let width = 0;
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0x2e7f ? em : em * 0.56;
  return width;
}

/**
 * The size of a to-do's capsule before the page has measured it (and in a
 * test, where nothing is measured): the mark, the title up to its limit, and
 * the few words of its deadline.
 */
export function estimateCapsule(title: string, depth: Depth, density: Density, meta = ''): { w: number; h: number } {
  const spec = CAPSULE[density][depth] as { h: number; em: number; title: number };
  const metaWidth = meta.length === 0 ? 0 : 8 + textWidth(meta, 12);
  const width = CAPSULE_CHROME + Math.min(textWidth(title, spec.em), spec.title) + metaWidth;
  return { w: Math.round(Math.max(88, width)), h: spec.h };
}

// ── Folders ─────────────────────────────────────────────────────────────
export interface FolderInput {
  readonly id: string;
  /** Open to-dos filed in it. */
  readonly count: number;
  readonly collapsed: boolean;
  /** Where its centre was left, as a fraction of the surface. */
  readonly place?: Fraction | undefined;
  /** Its name's length in glyphs (the folded object is as wide as its label). */
  readonly labelLength: number;
  /**
   * The widths of its to-dos' capsules, most urgent first: the dish is as
   * large as they need. Without them a usual width is assumed for each.
   */
  readonly widths?: readonly number[];
}

export interface FolderBox {
  readonly id: string;
  readonly collapsed: boolean;
  /** The dish (or the folded object) on the surface. */
  readonly box: Box;
  /** Where its to-dos float: the dish under its label. Null while folded. */
  readonly inner: Box | null;
  /** How many of its to-dos are drawn; the rest are "+N". */
  readonly shown: number;
  readonly hidden: number;
}

export const DISH_HEAD = 44;
export const DISH_PAD = 10;
/**
 * A dish holds its to-dos in rows, flowed like words into lines: as many
 * capsules to a row as fit its width. A row is a compact capsule, the gap
 * under it and a little air.
 */
const DISH_ROW = 50;
/** …and the least a row can be before the capsules in it touch. */
const DISH_ROW_MIN = 46;
/** A dish of up to three to-dos is this wide; a fuller one, twice a capsule. */
const DISH_WIDTH = { small: 264, large: 404 } as const;
const DISH_SMALL_COUNT = 3;
/** Rows a dish shows before it says "+N". */
const DISH_MAX_ROWS = 6;
const DISH_EMPTY_HEIGHT = 104;
/** The width assumed for a capsule nobody has measured. */
const USUAL_CAPSULE = 168;
/** Dishes that overflow one column by no more than this are squeezed into it. */
const COLUMN_SQUEEZE = 1.25;
export const FOLDED_HEIGHT = 52;

/**
 * Capsules of `widths` flowed into rows of `room` pixels, `gap` apart, in
 * the order given: each row is the indexes it holds. One wider than the room
 * has a row to itself.
 */
export function flowRows(widths: readonly number[], room: number, gap: number): number[][] {
  const rows: number[][] = [];
  let used = 0;
  widths.forEach((width, index) => {
    const row = rows[rows.length - 1];
    if (row === undefined || used + gap + width > room) {
      rows.push([index]);
      used = width;
    } else {
      row.push(index);
      used += gap + width;
    }
  });
  return rows;
}

/** The pixels of a dish's width that capsules can lie in. */
function dishRoom(width: number): number {
  // The same room `flowPlaces` flows them into: the dish's inside, less its pad.
  return width - 2 * INSIDE_PAD;
}

/**
 * A dish as large as what it holds needs. `maxWidth` is the most the surface
 * gives it; `width` fixes it (a narrow surface's dishes are as wide as the
 * surface). `shown` is how many of its to-dos its rows hold (the rest are
 * "+N"), `least` the height it cannot go under without crowding them.
 */
export function dishSize(
  widths: readonly number[],
  maxWidth: number,
  width?: number,
): { w: number; h: number; shown: number; least: number } {
  const limit = Math.max(160, maxWidth);
  const widest = widths.reduce((most, item) => Math.max(most, item), 0);
  const wanted = widths.length > DISH_SMALL_COUNT ? DISH_WIDTH.large : DISH_WIDTH.small;
  // Wide enough for its widest capsule, whatever else.
  const w = Math.round(width ?? Math.min(limit, Math.max(wanted, widest + 2 * INSIDE_PAD + 8)));
  if (widths.length === 0) return { w, h: DISH_EMPTY_HEIGHT, shown: 0, least: DISH_EMPTY_HEIGHT };
  const rows = flowRows(widths, dishRoom(w), INSIDE_GAP).slice(0, DISH_MAX_ROWS);
  return {
    w,
    h: DISH_HEAD + rows.length * DISH_ROW + 2 * DISH_PAD,
    shown: rows.reduce((sum, row) => sum + row.length, 0),
    least: DISH_HEAD + rows.length * DISH_ROW_MIN + 2 * DISH_PAD,
  };
}

function foldedSize(labelLength: number, maxWidth: number): { w: number; h: number } {
  return { w: Math.round(Math.max(132, Math.min(92 + labelLength * 15, 248, maxWidth))), h: FOLDED_HEIGHT };
}

/** Below this the surface is a vertical field: dishes take its width and stack under the open water. */
export const NARROW_SURFACE = 560;

/**
 * The folders' dishes on a surface of `width` × `height`. One the owner
 * placed is where they left it; the others line up down the right edge (a
 * narrow surface stacks them at its foot). Dishes are then pushed apart so
 * no two overlap and none leaves the surface.
 */
export function layoutFolders(folders: readonly FolderInput[], surface: { width: number; height: number }, gap = 14): FolderBox[] {
  const pad = 12;
  const narrow = surface.width < NARROW_SURFACE;
  const maxWidth = surface.width - 2 * pad;
  const sizes = folders.map((folder) => {
    if (folder.collapsed) {
      const folded = foldedSize(folder.labelLength, maxWidth);
      return { ...folded, shown: 0, least: folded.h };
    }
    const widths = folder.widths ?? Array.from({ length: Math.max(0, folder.count) }, () => USUAL_CAPSULE);
    return narrow ? dishSize(widths, maxWidth, maxWidth) : dishSize(widths, maxWidth);
  });

  // One column down the edge, if at all possible.
  if (!narrow && sizes.length > 0) {
    const air = (sizes.length - 1) * gap + 2 * pad;
    const room = surface.height - air;
    const heightOf = (): number => sizes.reduce((sum, size) => sum + size.h, 0);
    // Too tall: every open dish becomes a wide one, with two capsules to a row.
    if (heightOf() > room && maxWidth >= DISH_WIDTH.large * 2) {
      folders.forEach((folder, index) => {
        if (folder.collapsed) return;
        const widths = folder.widths ?? Array.from({ length: Math.max(0, folder.count) }, () => USUAL_CAPSULE);
        const wide = dishSize(widths, maxWidth, DISH_WIDTH.large);
        if (wide.h < (sizes[index] as { h: number }).h) sizes[index] = wide;
      });
    }
    // Still a little too tall: each gives up air — never below what its to-dos need.
    const total = heightOf();
    if (total > room && total <= room * COLUMN_SQUEEZE) {
      const open = sizes.filter((size, index) => !(folders[index] as FolderInput).collapsed && size.h > size.least);
      const spare = open.reduce((sum, size) => sum + size.h - size.least, 0);
      const over = Math.min(total - room, spare);
      if (spare > 0) {
        for (const size of open) size.h = Math.floor(size.h - ((size.h - size.least) / spare) * over);
      }
    }
  }

  // Default places: a column down the right edge (wide), a stack at the foot (narrow).
  const centres: Point[] = [];
  if (narrow) {
    let bottom = surface.height - pad;
    for (let index = folders.length - 1; index >= 0; index -= 1) {
      const size = sizes[index] as { w: number; h: number };
      centres[index] = { x: surface.width / 2, y: bottom - size.h / 2 };
      bottom -= size.h + gap;
    }
  } else {
    let right = surface.width - pad;
    let top = pad;
    let columnWidth = 0;
    folders.forEach((_folder, index) => {
      const size = sizes[index] as { w: number; h: number };
      if (top + size.h > surface.height - pad && top > pad) {
        right -= columnWidth + gap;
        top = pad;
        columnWidth = 0;
      }
      centres[index] = { x: right - size.w / 2, y: top + size.h / 2 };
      top += size.h + gap;
      columnWidth = Math.max(columnWidth, size.w);
    });
  }

  const bodies = folders.map((folder, index) => {
    const size = sizes[index] as { w: number; h: number };
    const at = folder.place === undefined ? (centres[index] as Point) : { x: folder.place.u * surface.width, y: folder.place.v * surface.height };
    return createBody(folder.id, size, at);
  });
  settle(bodies, { width: surface.width, height: surface.height, regions: [], obstacles: [] }, { gap: gap / 2, pad });

  return folders.map((folder, index) => {
    const body = bodies[index] as Body;
    const size = sizes[index] as { w: number; h: number; shown: number };
    const box: Box = { left: Math.round(body.x - body.w / 2), top: Math.round(body.y - body.h / 2), width: body.w, height: body.h };
    if (folder.collapsed) return { id: folder.id, collapsed: true, box, inner: null, shown: 0, hidden: folder.count };
    const shown = Math.min(folder.count, size.shown);
    return {
      id: folder.id,
      collapsed: false,
      box,
      inner: { left: box.left, top: box.top + DISH_HEAD, width: box.width, height: box.height - DISH_HEAD },
      shown,
      hidden: folder.count - shown,
    };
  });
}

export function dishAreaOf(folders: readonly FolderBox[]): number {
  return folders.reduce((sum, folder) => sum + folder.box.width * folder.box.height, 0);
}

/** The simulation's world for a surface and its dishes. */
export function worldOf(surface: { width: number; height: number }, folders: readonly FolderBox[]): World {
  const regions: Region[] = [];
  for (const folder of folders) if (folder.inner !== null) regions.push({ id: folder.id, box: folder.inner });
  return { width: surface.width, height: surface.height, regions, obstacles: folders.map((folder) => folder.box) };
}

// ── Anchors ─────────────────────────────────────────────────────────────
export function regionBox(world: World, region: string | null): Box {
  if (region !== null) {
    const found = world.regions.find((item) => item.id === region);
    if (found !== undefined) return found.box;
  }
  return { left: 0, top: 0, width: world.width, height: world.height };
}

/** A body's anchor as a fraction of what holds it: what is remembered. */
export function fractionOf(body: Pick<Body, 'x' | 'y' | 'region'>, world: World): Fraction {
  const box = regionBox(world, body.region);
  const clamp = (value: number): number => Math.max(0, Math.min(1, value));
  return {
    u: box.width <= 0 ? 0.5 : clamp((body.x - box.left) / box.width),
    v: box.height <= 0 ? 0.5 : clamp((body.y - box.top) / box.height),
  };
}

export function pointOf(fraction: Fraction, box: Box): Point {
  return { x: box.left + fraction.u * box.width, y: box.top + fraction.v * box.height };
}

/**
 * The part of the open water a seeded field is centred on: the surface less
 * the band its dishes stand in (the right side; on a narrow surface, the foot).
 */
export function openWater(world: World): Box {
  if (world.obstacles.length === 0) return { left: 0, top: 0, width: world.width, height: world.height };
  if (world.width < NARROW_SURFACE) {
    const top = Math.min(...world.obstacles.map((box) => box.top));
    return { left: 0, top: 0, width: world.width, height: Math.max(world.height * 0.3, top) };
  }
  const left = Math.min(...world.obstacles.map((box) => box.left));
  // Dishes the owner moved into the middle leave the whole surface as water.
  if (left < world.width * 0.45) return { left: 0, top: 0, width: world.width, height: world.height };
  return { left: 0, top: 0, width: left, height: world.height };
}

/**
 * Where a dish keeps its to-dos: flowed into rows in the order given (the
 * same rows the dish was sized for), each row's slack going to alternate
 * sides so that it is not a table. What is filed is put away — a dish is
 * always tidy, whatever was dropped into it and wherever.
 */
export function flowPlaces(
  peers: readonly { readonly id: string; readonly w: number; readonly h: number }[],
  dish: Box,
  options: Pick<PlaceOptions, 'gap' | 'pad' | 'insideGap' | 'insidePad'>,
): Map<string, Point> {
  const places = new Map<string, Point>();
  const pad = options.insidePad ?? options.pad;
  const gap = options.insideGap ?? options.gap;
  const room = dish.width - 2 * pad;
  const rows = flowRows(
    peers.map((peer) => peer.w),
    room,
    gap,
  );
  const rowHeight = Math.max(1, (dish.height - 2 * pad) / Math.max(1, rows.length));
  rows.forEach((row, rowIndex) => {
    const used = row.reduce((sum, index) => sum + (peers[index] as { w: number }).w, 0) + (row.length - 1) * gap;
    const slack = Math.max(0, room - used);
    let x = dish.left + pad + (rowIndex % 2 === 0 ? slack * 0.25 : slack * 0.75);
    for (const index of row) {
      const peer = peers[index] as { id: string; w: number };
      places.set(peer.id, { x: x + peer.w / 2, y: dish.top + pad + rowHeight * (rowIndex + 0.5) });
      x += peer.w + gap;
    }
  });
  return places;
}

export interface SeedItem {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly region: string | null;
}

export interface PlaceOptions {
  readonly gap: number;
  readonly pad: number;
  readonly insideGap?: number;
  readonly insidePad?: number;
  /**
   * How far down the open water a seeded field is centred (px from its top).
   * On a surface longer than the window this is the middle of the first
   * window, so the most urgent to-dos are what is seen first. Default: the middle.
   */
  readonly focusY?: number;
  /**
   * Parts of the open water an arrival is not placed under (`freeSpot`): what
   * floats over the surface and would cover it — the foot bar (`footBarBox`).
   */
  readonly keepClear?: readonly Box[];
}

/** A field of fewer to-dos than this gathers nearer its middle instead of spreading to the edges. */
const FULL_FIELD = 14;

/** The simulation's distances for a density: the open water's, and a folder's inside. */
export function bodySpacing(density: Density): Required<Omit<PlaceOptions, 'focusY' | 'keepClear'>> {
  return { gap: BODY_GAP[density], pad: BODY_PAD, insideGap: INSIDE_GAP, insidePad: INSIDE_PAD };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Bodies for `items` (given most urgent first). One with a remembered place
 * is put there. The others are seeded on a sunflower spiral over what holds
 * them — the most urgent in the middle, the rest outward — turned by an angle
 * that comes from the region, so two folders are not copies of each other.
 * Then the whole surface is settled: nothing overlaps, nothing is in a dish
 * it does not belong to, nothing is off the surface.
 */
export function placeBodies(
  items: readonly SeedItem[],
  world: World,
  saved: ReadonlyMap<string, Fraction>,
  options: PlaceOptions,
): Body[] {
  const water = openWater(world);
  const fresh = new Map<string | null, SeedItem[]>();
  for (const item of items) {
    if (saved.has(item.id)) continue;
    const list = fresh.get(item.region);
    if (list === undefined) fresh.set(item.region, [item]);
    else list.push(item);
  }

  // The seeded places of each water: a sunflower over the whole of what holds
  // it (so the field is evenly full), handed out nearest-the-focus first.
  const seeded = new Map<string, Point>();
  for (const [region, peers] of fresh) {
    if (region !== null) {
      for (const [id, at] of flowPlaces(peers, regionBox(world, region), options)) seeded.set(id, at);
      continue;
    }
    const box = region === null ? water : regionBox(world, region);
    const pad = region === null ? options.pad : (options.insidePad ?? options.pad);
    const turn = (hashSeed(region ?? 'open-water') / 4294967296) * Math.PI * 2;
    // A handful of to-dos keep together; a full field reaches the edges.
    const spread = region === null ? Math.min(1, Math.sqrt(peers.length / FULL_FIELD)) : 1;
    const focusY = region === null && options.focusY !== undefined ? Math.max(0, Math.min(options.focusY, box.height)) : box.height / 2;
    const focus = { x: box.left + box.width / 2, y: box.top + focusY };
    const points = peers.map((_peer, index) => {
      const radius = Math.sqrt((index + 0.5) / peers.length) * spread;
      const angle = index * GOLDEN_ANGLE + turn;
      return {
        // A small field gathers around the focus; a full one is laid over the whole box.
        x: box.left + box.width / 2 + radius * Math.max(0, box.width / 2 - pad) * Math.cos(angle),
        y: (spread < 1 ? focus.y : box.top + box.height / 2) + radius * Math.max(0, box.height / 2 - pad) * Math.sin(angle),
      };
    });
    const nearest = points
      .map((point, index) => ({ point, index, far: Math.hypot((point.x - focus.x) / Math.max(1, box.width), (point.y - focus.y) / Math.max(1, box.height)) }))
      .sort((a, b) => a.far - b.far || a.index - b.index);
    peers.forEach((peer, index) => seeded.set(peer.id, (nearest[index] as { point: Point }).point));
  }

  const bodies = items.map((item) => {
    const place = saved.get(item.id);
    const at = place !== undefined ? pointOf(place, regionBox(world, item.region)) : (seeded.get(item.id) as Point);
    return createBody(item.id, item, at, item.region);
  });
  settle(bodies, world, options);
  return bodies;
}

/** The room the surface's floating foot bar takes: the selection's actions, or "더 보기". */
export const FOOT_BAR = { width: 440, height: 96 } as const;

/**
 * Where the foot bar stands over the open water: centred on its lower edge.
 * A to-do under it cannot be pointed at while the bar is up — and the bar is
 * up exactly when to-dos are being picked. So an arrival is never put there
 * (`PlaceOptions.keepClear`). On a surface longer than the window the bar
 * follows the scroll; this is where it stands when the surface fits, and the
 * end of the surface when it does not.
 */
export function footBarBox(world: World): Box {
  const water = openWater(world);
  const width = Math.min(water.width, FOOT_BAR.width);
  const height = Math.min(water.height, FOOT_BAR.height);
  return { left: water.left + (water.width - width) / 2, top: water.top + water.height - height, width, height };
}

function covers(box: Box, point: Point, item: { readonly w: number; readonly h: number }): boolean {
  return (
    Math.abs(box.left + box.width / 2 - point.x) < (box.width + item.w) / 2 &&
    Math.abs(box.top + box.height / 2 - point.y) < (box.height + item.h) / 2
  );
}

/**
 * A place for one more body among `bodies`: of a handful of candidates drawn
 * from its id, the one with the most room around it. (A to-do that has just
 * been put down arrives here.) A candidate under something that must be kept
 * clear (`options.keepClear`, the open water only) is not one.
 */
export function freeSpot(
  bodies: readonly Body[],
  world: World,
  item: SeedItem,
  options: PlaceOptions,
  candidates = 28,
): Point {
  const box = item.region === null ? openWater(world) : regionBox(world, item.region);
  const next = seededRandom(hashSeed(item.id));
  const pad = item.region === null ? options.pad : (options.insidePad ?? options.pad);
  const spanX = Math.max(0, box.width - 2 * pad - item.w);
  const spanY = Math.max(0, box.height - 2 * pad - item.h);
  let best: Point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  let bestRoom = -Infinity;
  for (let index = 0; index < candidates; index += 1) {
    const point = { x: box.left + pad + item.w / 2 + next() * spanX, y: box.top + pad + item.h / 2 + next() * spanY };
    if (item.region === null && (options.keepClear ?? []).some((clear) => covers(clear, point, item))) continue;
    let room = Infinity;
    for (const body of bodies) {
      if (body.region !== item.region) continue;
      const dx = Math.abs(body.x - point.x) - (body.w + item.w) / 2;
      const dy = Math.abs(body.y - point.y) - (body.h + item.h) / 2;
      room = Math.min(room, Math.max(dx, dy));
    }
    if (item.region === null) {
      for (const dish of world.obstacles) {
        const dx = Math.abs(dish.left + dish.width / 2 - point.x) - (dish.width + item.w) / 2;
        const dy = Math.abs(dish.top + dish.height / 2 - point.y) - (dish.height + item.h) / 2;
        room = Math.min(room, Math.max(dx, dy));
      }
    }
    if (room > bestRoom) {
      bestRoom = room;
      best = point;
    }
  }
  return best;
}

// ── Hit-testing ─────────────────────────────────────────────────────────
function contains(box: Box, point: Point, slack = 0): boolean {
  return (
    point.x >= box.left - slack &&
    point.x <= box.left + box.width + slack &&
    point.y >= box.top - slack &&
    point.y <= box.top + box.height + slack
  );
}

/**
 * The folder a point is over (where a dragged to-do would be filed), or null
 * for the open water. A folded folder is a small target, so it takes a little
 * slack; where dishes overlap, the later one is on top.
 */
export function folderAt(point: Point, folders: readonly FolderBox[]): string | null {
  for (let index = folders.length - 1; index >= 0; index -= 1) {
    const folder = folders[index] as FolderBox;
    if (contains(folder.box, point, folder.collapsed ? 10 : 0)) return folder.id;
  }
  return null;
}

/** The body whose capsule a point is on (the last one drawn wins), or null. */
export function bodyAt(point: Point, bodies: readonly Body[]): string | null {
  for (let index = bodies.length - 1; index >= 0; index -= 1) {
    const body = bodies[index] as Body;
    if (Math.abs(point.x - body.x) <= body.w / 2 && Math.abs(point.y - body.y) <= body.h / 2) return body.id;
  }
  return null;
}

/** Ids of the bodies a lasso touches. A lasso is any two corners. */
export function bodiesIn(from: Point, to: Point, bodies: readonly Body[]): string[] {
  const left = Math.min(from.x, to.x);
  const right = Math.max(from.x, to.x);
  const top = Math.min(from.y, to.y);
  const bottom = Math.max(from.y, to.y);
  return bodies
    .filter((body) => body.x + body.w / 2 >= left && body.x - body.w / 2 <= right && body.y + body.h / 2 >= top && body.y - body.h / 2 <= bottom)
    .map((body) => body.id);
}
