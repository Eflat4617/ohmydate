import { describe, expect, it } from 'vitest';
import {
  BODY_GAP,
  BODY_PAD,
  FOOTPRINT,
  SWAY_REACH,
  NARROW_SURFACE,
  SURFACE_GROWTH,
  SURFACE_HARD_CAP,
  bodiesIn,
  bodyAt,
  bodySpacing,
  byUrgency,
  depthOf,
  dishAreaOf,
  dishSize,
  estimateCapsule,
  folderAt,
  fractionOf,
  freeSpot,
  layoutFolders,
  openWater,
  placeBodies,
  planDensity,
  pointOf,
  worldOf,
  type FolderInput,
  type Fraction,
  type SeedItem,
} from '../src/domain/canvas/layout';
import { IGNORE_ABOVE_MS, SLOW_FOR_MS, STILL_ABOVE_MS, THIN_ABOVE_MS, createGovernor, governorTick } from '../src/domain/canvas/governor';
import { edgeOf, neighbour, readingOrder, type Placed } from '../src/domain/canvas/order';
import { hashSeed, seededRandom } from '../src/domain/canvas/random';
import { NO_SELECTION, all, extendTo, lasso, only, ordered, prune, toggle } from '../src/domain/canvas/selection';
import {
  CALM_INNER,
  CALM_OUTER,
  REST_EPSILON,
  SWAY_TILT_DEG,
  calmAt,
  createBody,
  distanceTo,
  easeDrift,
  overlapping,
  relax,
  settle,
  swayAt,
  swayOf,
  type Body,
  type World,
} from '../src/domain/canvas/sim';
import { canvasTodos, dueChipOf, dueToneOf } from '../src/domain/canvas/todo';

/**
 * HOLO-05, the pure parts of the 할 일 canvas: the seeded generator, the
 * simulation step (separation, bounds, settling near the pointer,
 * determinism), layout seeding from remembered places, the folders' dishes
 * and their hit-test, the selection model, the keyboard's order, and the
 * density rule.
 */
const GAP = 22;
const PAD = 14;
const SURFACE = { width: 1100, height: 700 };
const OPEN: World = { ...SURFACE, regions: [], obstacles: [] };

function items(count: number, region: string | null = null, prefix = 'todo'): SeedItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    w: 120 + ((index * 37) % 110),
    h: index % 3 === 0 ? 46 : 40,
    region,
  }));
}

function anyOverlap(bodies: readonly Body[], gap: number): boolean {
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      if (overlapping(bodies[i] as Body, bodies[j] as Body, gap)) return true;
    }
  }
  return false;
}

function insideBox(body: Body, box: { left: number; top: number; width: number; height: number }, pad: number): boolean {
  return (
    body.x - body.w / 2 >= box.left + pad - 0.5 &&
    body.x + body.w / 2 <= box.left + box.width - pad + 0.5 &&
    body.y - body.h / 2 >= box.top + pad - 0.5 &&
    body.y + body.h / 2 <= box.top + box.height - pad + 0.5
  );
}

describe('the seeded generator', () => {
  it('gives the same numbers for the same seed, all in [0, 1)', () => {
    const a = seededRandom(hashSeed('todo-1'));
    const b = seededRandom(hashSeed('todo-1'));
    const first = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(45);
  });

  it('gives another sequence for another seed (negative)', () => {
    const a = seededRandom(hashSeed('todo-1'));
    const b = seededRandom(hashSeed('todo-2'));
    expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
    expect(hashSeed('가나다')).not.toBe(hashSeed('가나라'));
  });
});

describe('the sway: a body moored to its anchor', () => {
  it('is a closed form of time: the same body at the same time is at the same place', () => {
    const body = { ...createBody('todo-7', { w: 160, h: 40 }, { x: 0, y: 0 }), drift: 1 };
    expect(swayAt(body, 12.5, 8)).toEqual(swayAt(body, 12.5, 8));
    expect(swayOf('todo-7')).toEqual(swayOf('todo-7'));
    expect(swayOf('todo-7')).not.toEqual(swayOf('todo-8'));
  });

  it('never carries a body further than the reach, and never tilts it past the limit', () => {
    for (const id of ['a', 'b', 'c', 'todo-41']) {
      const body = { ...createBody(id, { w: 160, h: 40 }, { x: 0, y: 0 }), drift: 1 };
      for (let time = 0; time < 240; time += 0.37) {
        const offset = swayAt(body, time, 8);
        expect(Math.abs(offset.dx)).toBeLessThanOrEqual(8);
        expect(Math.abs(offset.dy)).toBeLessThanOrEqual(8);
        expect(Math.abs(offset.tilt)).toBeLessThanOrEqual(SWAY_TILT_DEG);
      }
    }
  });

  it('is exactly on its anchor while it holds still (negative)', () => {
    const body = createBody('todo-7', { w: 160, h: 40 }, { x: 0, y: 0 });
    expect(body.drift).toBe(0);
    expect(swayAt(body, 33, 8)).toEqual({ dx: 0, dy: 0, tilt: 0 });
    expect(swayAt({ ...body, drift: 1 }, 33, 0)).toEqual({ dx: 0, dy: 0, tilt: 0 });
  });

  it('moves slowly: one period is at least nine seconds', () => {
    const sway = swayOf('todo-3');
    expect((Math.PI * 2) / sway.wx).toBeGreaterThanOrEqual(9);
    expect((Math.PI * 2) / sway.wy).toBeLessThanOrEqual(17.01);
  });
});

describe('the step: separation, bounds, rest', () => {
  it('pushes two bodies on top of each other apart until they are a gap apart', () => {
    const a = createBody('a', { w: 160, h: 40 }, { x: 400, y: 300 });
    const b = createBody('b', { w: 160, h: 40 }, { x: 410, y: 304 });
    expect(overlapping(a, b, GAP)).toBe(true);
    settle([a, b], OPEN, { gap: GAP, pad: PAD });
    expect(overlapping(a, b, GAP - 0.5)).toBe(false);
  });

  it('is soft: one frame closes only part of an overlap', () => {
    const a = createBody('a', { w: 160, h: 40 }, { x: 400, y: 300 });
    const b = createBody('b', { w: 160, h: 40 }, { x: 430, y: 300 });
    const moved = relax([a, b], OPEN, { dt: 1 / 60, gap: GAP, pad: PAD });
    expect(moved).toBeGreaterThan(0);
    expect(overlapping(a, b, GAP)).toBe(true);
  });

  it('separates two bodies at exactly the same point, the same way every time', () => {
    const run = (): Body[] => {
      const pair = [createBody('a', { w: 120, h: 40 }, { x: 500, y: 350 }), createBody('b', { w: 120, h: 40 }, { x: 500, y: 350 })];
      settle(pair, OPEN, { gap: GAP, pad: PAD });
      return pair;
    };
    const first = run();
    expect(overlapping(first[0] as Body, first[1] as Body, GAP - 0.5)).toBe(false);
    expect(run().map((body) => [body.x, body.y])).toEqual(first.map((body) => [body.x, body.y]));
  });

  it('leaves bodies that are already apart where they are (negative)', () => {
    const a = createBody('a', { w: 160, h: 40 }, { x: 200, y: 200 });
    const b = createBody('b', { w: 160, h: 40 }, { x: 600, y: 400 });
    expect(relax([a, b], OPEN, { dt: 1 / 60, gap: GAP, pad: PAD })).toBe(0);
    expect([a.x, a.y, b.x, b.y]).toEqual([200, 200, 600, 400]);
  });

  it('never lets a body leave the surface, and brings one that is outside back', () => {
    const lost = createBody('lost', { w: 160, h: 40 }, { x: -300, y: 2000 });
    settle([lost], OPEN, { gap: GAP, pad: PAD });
    expect(insideBox(lost, { left: 0, top: 0, ...SURFACE }, PAD)).toBe(true);

    const bodies = placeBodies(items(40), OPEN, new Map(), { gap: GAP, pad: PAD });
    for (let frame = 0; frame < 120; frame += 1) relax(bodies, OPEN, { dt: 1 / 60, gap: GAP, pad: PAD });
    expect(bodies.every((body) => insideBox(body, { left: 0, top: 0, ...SURFACE }, PAD))).toBe(true);
  });

  it('a held body is not moved; what it lands on gives way entirely', () => {
    const held = { ...createBody('held', { w: 160, h: 40 }, { x: 400, y: 300 }), held: true };
    const other = createBody('other', { w: 160, h: 40 }, { x: 420, y: 300 });
    settle([held, other], OPEN, { gap: GAP, pad: PAD });
    expect([held.x, held.y]).toEqual([400, 300]);
    expect(overlapping(held, other, GAP - 0.5)).toBe(false);
  });

  it('keeps the open water out of a folder’s dish and a folder’s to-dos inside it', () => {
    const folders = layoutFolders([{ id: 'f1', count: 4, collapsed: false, labelLength: 4 }], SURFACE);
    const world = worldOf(SURFACE, folders);
    const dish = (folders[0] as { box: { left: number; top: number; width: number; height: number } }).box;
    const intruder = createBody('open', { w: 140, h: 40 }, { x: dish.left + dish.width / 2, y: dish.top + dish.height / 2 });
    const filed = createBody('filed', { w: 140, h: 40 }, { x: 50, y: 50 }, 'f1');
    settle([intruder, filed], world, { gap: GAP, pad: PAD });
    const overlapsDish =
      Math.abs(intruder.x - (dish.left + dish.width / 2)) < (intruder.w + dish.width) / 2 &&
      Math.abs(intruder.y - (dish.top + dish.height / 2)) < (intruder.h + dish.height) / 2;
    expect(overlapsDish).toBe(false);
    const inner = (world.regions[0] as { box: { left: number; top: number; width: number; height: number } }).box;
    expect(insideBox(filed, inner, PAD)).toBe(true);
  });

  it('bodies of different waters do not push each other (negative)', () => {
    const open = createBody('open', { w: 140, h: 40 }, { x: 300, y: 300 });
    const filed = createBody('filed', { w: 140, h: 40 }, { x: 300, y: 300 }, 'f1');
    const world: World = { ...SURFACE, regions: [{ id: 'f1', box: { left: 0, top: 0, ...SURFACE } }], obstacles: [] };
    expect(relax([open, filed], world, { dt: 1 / 60, gap: GAP, pad: PAD })).toBe(0);
  });

  it('comes to rest: after settling, a step moves nothing', () => {
    // As many compact capsules as the density rule lets a surface of this size hold.
    const count = planDensity({ count: 999, width: SURFACE.width, baseHeight: SURFACE.height / SURFACE_GROWTH, dishArea: 0, expanded: false }).shown;
    expect(count).toBeGreaterThan(45);
    const titles = ['졸업 논문 3장 초고', '세미나 발표 자료', '방 청소', '통계 과제 2번 풀이 정리해서 올리기', 'Read chapter 4'];
    const full: SeedItem[] = Array.from({ length: count }, (_unused, index) => ({
      id: `todo-${index}`,
      ...estimateCapsule(titles[index % titles.length] as string, (index % 3) as 0 | 1 | 2, 'compact', index % 2 === 0 ? 'D-3' : ''),
      region: null,
    }));
    const gap = BODY_GAP.compact;
    const bodies = placeBodies(full, OPEN, new Map(), { gap, pad: BODY_PAD });
    expect(relax(bodies, OPEN, { dt: 1 / 60, gap, pad: BODY_PAD })).toBeLessThan(REST_EPSILON);
    expect(anyOverlap(bodies, gap - 1)).toBe(false);
    // The sway never closes the gap: twice its reach is less than the gap, at both densities.
    expect(SWAY_REACH.compact * 2).toBeLessThan(BODY_GAP.compact);
    expect(SWAY_REACH.airy * 2).toBeLessThan(BODY_GAP.airy);
  });

  it('is deterministic: the same to-dos on the same surface make the same picture', () => {
    const one = placeBodies(items(30), OPEN, new Map(), { gap: GAP, pad: PAD });
    const two = placeBodies(items(30), OPEN, new Map(), { gap: GAP, pad: PAD });
    expect(two.map((body) => [body.id, body.x, body.y])).toEqual(one.map((body) => [body.id, body.x, body.y]));
    for (let frame = 0; frame < 30; frame += 1) {
      for (const set of [one, two]) {
        relax(set, OPEN, { dt: 1 / 60, gap: GAP, pad: PAD });
        easeDrift(set, { dt: 1 / 60, pointer: { x: 300, y: 300 } });
      }
    }
    expect(two.map((body) => [body.x, body.y, body.drift])).toEqual(one.map((body) => [body.x, body.y, body.drift]));
  });
});

describe('settling near the pointer', () => {
  it('a body under the pointer holds still, one far away sways freely', () => {
    expect(calmAt(0)).toBe(0);
    expect(calmAt(CALM_INNER)).toBe(0);
    expect(calmAt(CALM_OUTER)).toBe(1);
    expect(calmAt(CALM_OUTER * 4)).toBe(1);
    const middle = calmAt((CALM_INNER + CALM_OUTER) / 2);
    expect(middle).toBeGreaterThan(0.4);
    expect(middle).toBeLessThan(0.6);
  });

  it('measures the distance from a body’s edge, not its centre', () => {
    const body = createBody('a', { w: 200, h: 40 }, { x: 500, y: 300 });
    expect(distanceTo(body, { x: 590, y: 310 })).toBe(0);
    expect(distanceTo(body, { x: 630, y: 300 })).toBe(30);
  });

  it('settles quickly and wakes gently', () => {
    const body = { ...createBody('a', { w: 160, h: 40 }, { x: 500, y: 300 }), drift: 1 };
    // The pointer arrives: a quarter of a second later it is all but still.
    for (let frame = 0; frame < 15; frame += 1) easeDrift([body], { dt: 1 / 60, pointer: { x: 500, y: 300 } });
    expect(body.drift).toBeLessThan(0.1);
    // The pointer leaves: after the same quarter second it has barely begun to move again.
    for (let frame = 0; frame < 15; frame += 1) easeDrift([body], { dt: 1 / 60, pointer: null });
    expect(body.drift).toBeLessThan(0.4);
    for (let frame = 0; frame < 600; frame += 1) easeDrift([body], { dt: 1 / 60, pointer: null });
    expect(body.drift).toBe(1);
  });

  it('a body in the hand, in focus or picked stays still even with the pointer far away (negative)', () => {
    const held = { ...createBody('held', { w: 160, h: 40 }, { x: 100, y: 100 }), drift: 1, held: true };
    const picked = { ...createBody('picked', { w: 160, h: 40 }, { x: 300, y: 100 }), drift: 1 };
    const free = { ...createBody('free', { w: 160, h: 40 }, { x: 600, y: 100 }), drift: 0 };
    for (let frame = 0; frame < 240; frame += 1) easeDrift([held, picked, free], { dt: 1 / 60, pointer: null, still: new Set(['picked']) });
    expect(held.drift).toBe(0);
    expect(picked.drift).toBe(0);
    expect(free.drift).toBeGreaterThan(0.9);
  });
});

describe('layout seeding', () => {
  it('puts a to-do back where it was left, as a fraction of what holds it', () => {
    const saved = new Map<string, Fraction>([['todo-0', { u: 0.25, v: 0.5 }]]);
    const bodies = placeBodies(items(1), OPEN, saved, { gap: GAP, pad: PAD });
    expect(Math.round((bodies[0] as Body).x)).toBe(275);
    expect(Math.round((bodies[0] as Body).y)).toBe(350);
    expect(fractionOf(bodies[0] as Body, OPEN)).toEqual({ u: 0.25, v: 0.5 });
    expect(pointOf({ u: 0.5, v: 0.5 }, { left: 100, top: 50, width: 200, height: 100 })).toEqual({ x: 200, y: 100 });
  });

  it('the same fraction lands in the same relative place on another surface', () => {
    const saved = new Map<string, Fraction>([['todo-0', { u: 0.8, v: 0.2 }]]);
    const small: World = { width: 360, height: 900, regions: [], obstacles: [] };
    const body = placeBodies(items(1), small, saved, { gap: GAP, pad: PAD })[0] as Body;
    expect(Math.abs(body.x - 0.8 * 360)).toBeLessThan(PAD + body.w / 2);
    expect(Math.round(body.y)).toBe(180);
  });

  it('seeds those never placed from the middle outward, in the order given', () => {
    const bodies = placeBodies(items(24), OPEN, new Map(), { gap: GAP, pad: PAD });
    const centre = { x: SURFACE.width / 2, y: SURFACE.height / 2 };
    const reach = (body: Body): number => Math.hypot((body.x - centre.x) / SURFACE.width, (body.y - centre.y) / SURFACE.height);
    const inner = bodies.slice(0, 6).reduce((sum, body) => sum + reach(body), 0) / 6;
    const outer = bodies.slice(18).reduce((sum, body) => sum + reach(body), 0) / 6;
    expect(inner).toBeLessThan(outer);
    expect(anyOverlap(bodies, GAP - 1)).toBe(false);
  });

  it('a remembered place that now overlaps another is eased apart, not kept on top (negative)', () => {
    const saved = new Map<string, Fraction>([
      ['todo-0', { u: 0.5, v: 0.5 }],
      ['todo-1', { u: 0.5, v: 0.5 }],
    ]);
    const bodies = placeBodies(items(2), OPEN, saved, { gap: GAP, pad: PAD });
    expect(overlapping(bodies[0] as Body, bodies[1] as Body, GAP - 0.5)).toBe(false);
  });

  it('seeds a folder’s to-dos inside its dish and the open water’s beside the dishes', () => {
    const folders = layoutFolders([{ id: 'f1', count: 5, collapsed: false, labelLength: 4 }], SURFACE);
    const world = worldOf(SURFACE, folders);
    const bodies = placeBodies([...items(12), ...items(5, 'f1', 'filed')], world, new Map(), { gap: 14, pad: 10 });
    const inner = (world.regions[0] as { box: { left: number; top: number; width: number; height: number } }).box;
    expect(bodies.filter((body) => body.region === 'f1').every((body) => insideBox(body, inner, 10))).toBe(true);
    const water = openWater(world);
    expect(water.width).toBeLessThan(SURFACE.width);
    const dish = (folders[0] as { box: { left: number } }).box;
    expect(bodies.filter((body) => body.region === null).every((body) => body.x + body.w / 2 <= dish.left)).toBe(true);
  });

  it('finds a new arrival a place with room around it, the same one every time', () => {
    const bodies = placeBodies(items(20), OPEN, new Map(), { gap: GAP, pad: PAD });
    const arrival: SeedItem = { id: 'new-one', w: 150, h: 40, region: null };
    const spot = freeSpot(bodies, OPEN, arrival, { gap: GAP, pad: PAD });
    expect(freeSpot(bodies, OPEN, arrival, { gap: GAP, pad: PAD })).toEqual(spot);
    expect(spot.x - arrival.w / 2).toBeGreaterThanOrEqual(PAD);
    expect(spot.x + arrival.w / 2).toBeLessThanOrEqual(SURFACE.width - PAD);
    expect(bodyAt(spot, bodies)).toBeNull();
  });
});

describe('depth and urgency', () => {
  const NOW = Date.parse('2026-11-14T09:40:00.000Z');
  const at = (days: number): string => new Date(NOW + days * 86_400_000).toISOString();

  it('draws a closer deadline nearer', () => {
    expect(depthOf(at(-3), NOW)).toBe(0);
    expect(depthOf(at(1), NOW)).toBe(0);
    expect(depthOf(at(5), NOW)).toBe(1);
    expect(depthOf(at(30), NOW)).toBe(2);
  });

  it('a to-do without a deadline, or with one that cannot be read, is far (negative)', () => {
    expect(depthOf(undefined, NOW)).toBe(2);
    expect(depthOf('not a date', NOW)).toBe(2);
  });

  it('orders by deadline, then the undated by newest', () => {
    const list = [
      { id: 'undated-old', createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'later', dueAt: at(9), createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'overdue', dueAt: at(-2), createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'undated-new', createdAt: '2026-11-10T00:00:00.000Z' },
      { id: 'soon', dueAt: at(1), createdAt: '2026-11-01T00:00:00.000Z' },
    ];
    expect(byUrgency(list).map((item) => item.id)).toEqual(['overdue', 'soon', 'later', 'undated-new', 'undated-old']);
  });

  it('a nearer capsule is taller, a compact one smaller, and a long title stops at the limit', () => {
    const near = estimateCapsule('발표 자료', 0, 'airy');
    const far = estimateCapsule('발표 자료', 2, 'airy');
    expect(near.h).toBeGreaterThan(far.h);
    expect(estimateCapsule('발표 자료', 0, 'compact').h).toBeLessThan(near.h);
    const long = estimateCapsule('아주 길고 길고 길고 길고 길고 길고 길고 길고 길고 긴 제목의 할 일', 0, 'airy');
    expect(long.w).toBe(12 + 18 + 8 + 216 + 16 + 2);
    expect(estimateCapsule('아주 길고 길고 길고 길고 길고 길고 길고 긴 제목', 0, 'compact').w).toBeLessThan(long.w);
    expect(estimateCapsule('가', 2, 'compact').w).toBeGreaterThanOrEqual(88);
    // The few words of a deadline make it wider.
    expect(estimateCapsule('발표 자료', 0, 'airy', '3일 남음').w).toBeGreaterThan(near.w);
  });
});

describe('the density rule', () => {
  const room = { width: 1100, baseHeight: 700, dishArea: 0, expanded: false };

  it('a few to-dos float at full size on a surface the height of the window', () => {
    expect(planDensity({ ...room, count: 5 })).toEqual({ density: 'airy', shown: 5, hidden: 0, height: 700 });
    expect(planDensity({ ...room, count: 30 })).toEqual({ density: 'airy', shown: 30, hidden: 0, height: 700 });
  });

  it('more of them come closer together before the surface grows', () => {
    const fits = Math.floor((1100 * 700) / FOOTPRINT.compact);
    expect(planDensity({ ...room, count: fits })).toEqual({ density: 'compact', shown: fits, hidden: 0, height: 700 });
  });

  it('then the surface grows, up to twice the window', () => {
    const plan = planDensity({ ...room, count: 90 });
    expect(plan.density).toBe('compact');
    expect(plan.hidden).toBe(0);
    expect(plan.height).toBeGreaterThan(700);
    expect(plan.height).toBeLessThanOrEqual(700 * SURFACE_GROWTH);
  });

  it('300 to-dos do not become noise: the most urgent are shown and the rest are one "N개 더"', () => {
    const plan = planDensity({ ...room, count: 300 });
    expect(plan.height).toBe(700 * SURFACE_GROWTH);
    expect(plan.shown).toBe(Math.floor((1100 * 1400) / FOOTPRINT.compact));
    expect(plan.shown + plan.hidden).toBe(300);
    expect(plan.hidden).toBeGreaterThan(150);
  });

  it('asked for them all, the surface is as long as it must be — but never more than the hard cap', () => {
    const plan = planDensity({ ...room, count: 200, expanded: true });
    expect(plan).toMatchObject({ shown: 200, hidden: 0 });
    expect(plan.height).toBeGreaterThan(700 * SURFACE_GROWTH);
    const many = planDensity({ ...room, count: 500, expanded: true });
    expect(many.shown).toBe(SURFACE_HARD_CAP);
    expect(many.hidden).toBe(200);
  });

  it('dishes take room from the open water', () => {
    expect(planDensity({ ...room, count: 30 }).density).toBe('airy');
    expect(planDensity({ ...room, count: 30, dishArea: 200_000 }).density).toBe('compact');
  });

  it('nothing to show is an empty surface, not a broken one (negative)', () => {
    expect(planDensity({ ...room, count: 0 })).toEqual({ density: 'airy', shown: 0, hidden: 0, height: 700 });
    expect(planDensity({ count: -3, width: 0, baseHeight: 0, dishArea: 0, expanded: false })).toMatchObject({ shown: 0, hidden: 0 });
  });
});

describe('folders: dishes on the surface', () => {
  const folder = (id: string, count: number, extra: Partial<FolderInput> = {}): FolderInput => ({ id, count, collapsed: false, labelLength: 4, ...extra });

  it('a dish grows with what it holds, within its limits, and says how many it can show', () => {
    const small = dishSize(1, 1000);
    const large = dishSize(12, 1000);
    expect(large.w * large.h).toBeGreaterThan(small.w * small.h);
    expect(dishSize(500, 1000).w).toBeLessThanOrEqual(420);
    expect(dishSize(500, 1000).h).toBeLessThanOrEqual(360);
    expect(dishSize(3, 1000).capacity).toBeGreaterThanOrEqual(3);
  });

  it('lines dishes up down the right edge, apart and on the surface', () => {
    const boxes = layoutFolders([folder('a', 3), folder('b', 6)], SURFACE);
    expect(boxes.map((item) => item.id)).toEqual(['a', 'b']);
    const [a, b] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    expect(a.box.left + a.box.width).toBeLessThanOrEqual(SURFACE.width);
    expect(a.box.left).toBeGreaterThan(SURFACE.width / 2);
    expect(b.box.top).toBeGreaterThanOrEqual(a.box.top + a.box.height);
    expect(dishAreaOf(boxes)).toBe(a.box.width * a.box.height + b.box.width * b.box.height);
    expect(a.inner?.top).toBe(a.box.top + 44);
  });

  it('a narrow surface stacks dishes at its foot, as wide as it is', () => {
    const phone = { width: 340, height: 1200 };
    expect(phone.width).toBeLessThan(NARROW_SURFACE);
    const boxes = layoutFolders([folder('a', 3), folder('b', 2)], phone);
    const [a, b] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    expect(a.box.width).toBe(340 - 24);
    expect(b.box.top + b.box.height).toBeLessThanOrEqual(phone.height);
    expect(a.box.top + a.box.height).toBeLessThanOrEqual(b.box.top);
    expect(openWater(worldOf(phone, boxes)).height).toBeLessThanOrEqual(a.box.top);
  });

  it('a dish the owner moved is where they left it; two left on one spot are pushed apart', () => {
    const moved = layoutFolders([folder('a', 3, { place: { u: 0.3, v: 0.4 } })], SURFACE)[0];
    expect(Math.round((moved?.box.left ?? 0) + (moved?.box.width ?? 0) / 2)).toBe(330);
    const [a, b] = layoutFolders([folder('a', 3, { place: { u: 0.5, v: 0.5 } }), folder('b', 3, { place: { u: 0.5, v: 0.5 } })], SURFACE);
    const apartX = Math.abs((a?.box.left ?? 0) - (b?.box.left ?? 0)) >= (a?.box.width ?? 0);
    const apartY = Math.abs((a?.box.top ?? 0) - (b?.box.top ?? 0)) >= (a?.box.height ?? 0);
    expect(apartX || apartY).toBe(true);
  });

  it('a folded folder is one small object with no inside, holding back everything in it', () => {
    const folded = layoutFolders([folder('a', 9, { collapsed: true })], SURFACE)[0];
    expect(folded).toMatchObject({ collapsed: true, inner: null, shown: 0, hidden: 9 });
    expect(folded?.box.height).toBe(52);
    expect(worldOf(SURFACE, [folded as NonNullable<typeof folded>]).regions).toEqual([]);
  });

  it('a dish that cannot show everything says how many it holds back', () => {
    const crowded = layoutFolders([folder('a', 80)], SURFACE)[0];
    expect((crowded?.shown ?? 0) + (crowded?.hidden ?? 0)).toBe(80);
    expect(crowded?.hidden).toBeGreaterThan(0);
  });

  it('hit-test: a point over a dish files into it, a point on the water does not (negative)', () => {
    const boxes = layoutFolders([folder('a', 3), folder('b', 3, { collapsed: true })], SURFACE);
    const [a, b] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    expect(folderAt({ x: a.box.left + 10, y: a.box.top + 10 }, boxes)).toBe('a');
    expect(folderAt({ x: 40, y: 40 }, boxes)).toBeNull();
    // A folded folder is a small target: a near miss still counts.
    expect(folderAt({ x: b.box.left - 8, y: b.box.top + 10 }, boxes)).toBe('b');
    expect(folderAt({ x: b.box.left - 30, y: b.box.top + 10 }, boxes)).toBeNull();
  });
});

describe('hit-testing bodies', () => {
  const bodies = [createBody('a', { w: 100, h: 40 }, { x: 100, y: 100 }), createBody('b', { w: 100, h: 40 }, { x: 300, y: 100 }), createBody('c', { w: 100, h: 40 }, { x: 300, y: 300 })];

  it('finds the body under a point, and nothing on empty water (negative)', () => {
    expect(bodyAt({ x: 120, y: 110 }, bodies)).toBe('a');
    expect(bodyAt({ x: 200, y: 100 }, bodies)).toBeNull();
  });

  it('a lasso catches everything it touches, whichever corner it was drawn from', () => {
    expect(bodiesIn({ x: 60, y: 60 }, { x: 320, y: 140 }, bodies)).toEqual(['a', 'b']);
    expect(bodiesIn({ x: 320, y: 140 }, { x: 60, y: 60 }, bodies)).toEqual(['a', 'b']);
    expect(bodiesIn({ x: 500, y: 500 }, { x: 600, y: 600 }, bodies)).toEqual([]);
  });
});

describe('the selection model', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('toggles one in and out', () => {
    const one = toggle(NO_SELECTION, 'b');
    expect([...one.ids]).toEqual(['b']);
    expect(one.anchor).toBe('b');
    const two = toggle(one, 'd');
    expect([...two.ids].sort()).toEqual(['b', 'd']);
    const back = toggle(two, 'd');
    expect([...back.ids]).toEqual(['b']);
    expect(toggle(back, 'b')).toEqual({ ids: new Set(), anchor: null });
  });

  it('extends from the anchor along the surface’s order, in either direction', () => {
    expect([...extendTo(only('b'), 'd', order).ids].sort()).toEqual(['b', 'c', 'd']);
    expect([...extendTo(only('d'), 'a', order).ids].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(extendTo(only('b'), 'd', order).anchor).toBe('b');
  });

  it('extending with no anchor, or to something that is not there, picks no range (negative)', () => {
    expect([...extendTo(NO_SELECTION, 'c', order).ids]).toEqual(['c']);
    expect(extendTo(only('b'), 'zzz', order)).toEqual(only('b'));
  });

  it('a lasso replaces the selection, or adds to it with Shift', () => {
    const start = only('a');
    expect([...lasso(start, ['c', 'd'], false).ids]).toEqual(['c', 'd']);
    expect([...lasso(start, ['c', 'd'], true).ids].sort()).toEqual(['a', 'c', 'd']);
    expect(lasso(start, [], false)).toEqual({ ids: new Set(), anchor: null });
  });

  it('selects everything, drops what is gone, and travels in the surface’s order', () => {
    expect(all(order).ids.size).toBe(5);
    const picked = lasso(NO_SELECTION, ['d', 'a', 'c'], false);
    expect(ordered(picked, order)).toEqual(['a', 'c', 'd']);
    const pruned = prune(picked, new Set(['a', 'b', 'c']));
    expect([...pruned.ids].sort()).toEqual(['a', 'c']);
    // Nothing gone: the very same selection comes back.
    expect(prune(pruned, new Set(order))).toBe(pruned);
  });
});

describe('the keyboard’s order', () => {
  const bodies: Placed[] = [
    { id: 'top-left', x: 100, y: 100, w: 120, h: 40 },
    { id: 'top-right', x: 400, y: 108, w: 120, h: 40 },
    { id: 'middle', x: 260, y: 220, w: 120, h: 40 },
    { id: 'bottom-left', x: 110, y: 340, w: 120, h: 40 },
    { id: 'bottom-right', x: 420, y: 330, w: 120, h: 40 },
  ];

  it('reads top to bottom and left to right, taking bodies a few pixels apart as one row', () => {
    expect(readingOrder(bodies).map((body) => body.id)).toEqual(['top-left', 'top-right', 'middle', 'bottom-left', 'bottom-right']);
    expect(edgeOf(bodies, 'first')).toBe('top-left');
    expect(edgeOf(bodies, 'last')).toBe('bottom-right');
  });

  it('an arrow goes to the nearest body that way', () => {
    expect(neighbour(bodies, 'top-left', 'right')).toBe('top-right');
    expect(neighbour(bodies, 'top-left', 'down')).toBe('bottom-left');
    expect(neighbour(bodies, 'middle', 'up')).toBe('top-right');
    expect(neighbour(bodies, 'bottom-right', 'left')).toBe('bottom-left');
    expect(neighbour(bodies, 'middle', 'down')).toBe('bottom-left');
  });

  it('prefers a body on the arrow’s line to a closer one far off it', () => {
    const line: Placed[] = [
      { id: 'from', x: 100, y: 100, w: 80, h: 40 },
      { id: 'ahead', x: 340, y: 104, w: 80, h: 40 },
      { id: 'askew', x: 190, y: 190, w: 80, h: 40 },
    ];
    expect(neighbour(line, 'from', 'right')).toBe('ahead');
  });

  it('stays put at the edge, and for a body that is not there (negative)', () => {
    expect(neighbour(bodies, 'top-left', 'left')).toBeNull();
    expect(neighbour(bodies, 'top-left', 'up')).toBeNull();
    expect(neighbour(bodies, 'nobody', 'right')).toBeNull();
    expect(edgeOf([], 'first')).toBeNull();
  });

  it('every body can be reached from the first with the arrow keys', () => {
    const field = placeBodies(items(30), OPEN, new Map(), { gap: GAP, pad: PAD });
    const reached = new Set<string>();
    const queue = [edgeOf(field, 'first') as string];
    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const direction of ['left', 'right', 'up', 'down'] as const) {
        const next = neighbour(field, id, direction);
        if (next !== null) queue.push(next);
      }
    }
    expect(reached.size).toBe(30);
  });
});

describe('what a to-do says about its deadline', () => {
  const ZONE = 'Asia/Seoul';
  // 2026-11-14 (Sat) 18:40 in Seoul.
  const NOW = Date.parse('2026-11-14T09:40:00.000Z');
  const seoul = (date: string, time: string): string => new Date(`${date}T${time}:00+09:00`).toISOString();

  it('says it in the fewest words: today, tomorrow, in N days, or — far off — as a date', () => {
    expect(dueChipOf(seoul('2026-11-14', '23:00'), NOW, ZONE)).toEqual({ kind: 'today' });
    expect(dueChipOf(seoul('2026-11-15', '00:30'), NOW, ZONE)).toEqual({ kind: 'tomorrow' });
    expect(dueChipOf(seoul('2026-11-20', '14:00'), NOW, ZONE)).toEqual({ kind: 'days', days: 6 });
    expect(dueChipOf(seoul('2026-12-10', '18:00'), NOW, ZONE)).toEqual({ kind: 'date' });
  });

  it('past is by the clock, and counted in the owner’s calendar days', () => {
    // Earlier today: past, by no whole day.
    expect(dueChipOf(seoul('2026-11-14', '09:00'), NOW, ZONE)).toEqual({ kind: 'overdue', days: 0 });
    expect(dueChipOf(seoul('2026-11-06', '18:00'), NOW, ZONE)).toEqual({ kind: 'overdue', days: 8 });
    // 23:30 on the 13th in Seoul is the 13th there, though still the 13th 14:30 in UTC.
    expect(dueChipOf('2026-11-13T14:30:00.000Z', NOW, ZONE)).toEqual({ kind: 'overdue', days: 1 });
  });

  it('nothing to say without a deadline, or with one that cannot be read (negative)', () => {
    expect(dueChipOf(undefined, NOW, ZONE)).toBeNull();
    expect(dueChipOf('soon', NOW, ZONE)).toBeNull();
  });

  it('is loud within the week, quiet further off, and red only when past', () => {
    expect(dueToneOf({ kind: 'overdue', days: 2 })).toBe('overdue');
    expect(dueToneOf({ kind: 'today' })).toBe('soon');
    expect(dueToneOf({ kind: 'days', days: 7 })).toBe('soon');
    expect(dueToneOf({ kind: 'days', days: 8 })).toBe('far');
    expect(dueToneOf({ kind: 'date' })).toBe('far');
  });

  it('builds the canvas’s to-dos: open ones only, the inbox as the open water, a folder by its id, most urgent first', () => {
    const task = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: id,
      status: 'todo' as const,
      projectId: 'inbox',
      createdAt: '2026-11-01T00:00:00.000Z',
      ...extra,
    });
    const todos = canvasTodos(
      [
        task('undated'),
        task('filed', { projectId: 'folder-1', dueAt: seoul('2026-11-20', '14:00') }),
        task('overdue', { dueAt: seoul('2026-11-06', '18:00') }),
        task('finished', { status: 'done' }),
        task('elsewhere', { projectId: 'archived-folder' }),
        task('working', { status: 'in_progress', dueAt: seoul('2026-11-14', '23:00') }),
      ],
      { inboxId: 'inbox', folderIds: new Set(['folder-1']), plannedIds: new Set(['filed']), nowMs: NOW, timeZone: ZONE },
    );
    expect(todos.map((todo) => todo.task.id)).toEqual(['overdue', 'working', 'filed', 'undated']);
    expect(todos.map((todo) => todo.folderId)).toEqual([null, null, 'folder-1', null]);
    expect(todos.map((todo) => todo.depth)).toEqual([0, 0, 1, 2]);
    expect(todos.map((todo) => todo.overdue)).toEqual([true, false, false, false]);
    expect(todos.map((todo) => todo.planned)).toEqual([false, false, true, false]);
  });

  it('draws nothing of a project it does not know — an archived folder’s to-dos are not on the surface (negative)', () => {
    const todos = canvasTodos(
      [{ id: 'a', title: 'a', status: 'todo' as const, projectId: 'gone', createdAt: '2026-11-01T00:00:00.000Z' }],
      { inboxId: 'inbox', folderIds: new Set(), plannedIds: new Set(), nowMs: NOW, timeZone: ZONE },
    );
    expect(todos).toEqual([]);
  });
});

describe('a folder’s inside is closer together', () => {
  it('uses the folder’s own gap and pad for what is put away in it', () => {
    const spacing = bodySpacing('airy');
    expect(spacing.insideGap).toBeLessThan(spacing.gap);
    const folders = layoutFolders([{ id: 'f1', count: 4, collapsed: false, labelLength: 3 }], SURFACE);
    const world = worldOf(SURFACE, folders);
    const filed = items(4, 'f1', 'filed').map((item) => ({ ...item, w: 120, h: 36 }));
    const bodies = placeBodies(filed, world, new Map(), spacing);
    expect(anyOverlap(bodies, spacing.insideGap - 1)).toBe(false);
    const inner = (world.regions[0] as { box: { left: number; top: number; width: number; height: number } }).box;
    expect(bodies.every((body) => insideBox(body, inner, spacing.insidePad))).toBe(true);
  });
});

describe('the frame governor: thinned before it stutters', () => {
  it('stays at full motion on a steady sixty frames a second', () => {
    const governor = createGovernor();
    for (let frame = 0; frame < 600; frame += 1) governorTick(governor, 16.7);
    expect(governor.level).toBe('full');
  });

  it('steps down to thin after a sustained slow stretch, then to still — and never back up', () => {
    const governor = createGovernor();
    const slow = THIN_ABOVE_MS + 12;
    let frames = 0;
    while (governor.level === 'full' && frames < 1000) {
      governorTick(governor, slow);
      frames += 1;
    }
    expect(governor.level).toBe('thin');
    // It took a sustained stretch, not one bad frame.
    expect(frames * slow).toBeGreaterThanOrEqual(SLOW_FOR_MS);
    for (let frame = 0; frame < 400; frame += 1) governorTick(governor, STILL_ABOVE_MS + 20);
    expect(governor.level).toBe('still');
    for (let frame = 0; frame < 600; frame += 1) governorTick(governor, 16.7);
    expect(governor.level).toBe('still');
  });

  it('one long frame, or a tab coming back, changes nothing (negative)', () => {
    const governor = createGovernor();
    governorTick(governor, 200);
    for (let frame = 0; frame < 120; frame += 1) governorTick(governor, 16.7);
    governorTick(governor, IGNORE_ABOVE_MS + 5_000);
    governorTick(governor, 0);
    governorTick(governor, Number.NaN);
    expect(governor.level).toBe('full');
  });
});
