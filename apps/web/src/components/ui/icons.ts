/**
 * OhMyDate icon set: 24×24, 1.75px rounded strokes, drawn for this app.
 * Rendered as SVG elements by UiIcon (no v-html). Icons are decorative; the
 * accessible name always comes from visible text or an aria-label.
 */
export interface IconShape {
  readonly paths: readonly string[];
  /** Stroked circles: [cx, cy, r]. */
  readonly circles?: readonly (readonly [number, number, number])[];
  /** Filled dots: [cx, cy]. */
  readonly dots?: readonly (readonly [number, number])[];
}

export const ICONS = {
  today: {
    paths: ['M4.5 8.5h15', 'M8 3.5v3', 'M16 3.5v3', 'M6.5 5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z'],
    dots: [[12, 14.25]],
  },
  inbox: {
    paths: [
      'M4 13h4.2l1.4 2.5h4.8l1.4-2.5H20',
      'M6.3 6.2A2 2 0 0 1 8.2 5h7.6a2 2 0 0 1 1.9 1.2L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5z',
    ],
  },
  projects: {
    paths: ['M3.5 7.5a2 2 0 0 1 2-2h3.7l2 2h7.3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  },
  plan: {
    paths: [
      'M11 3.5l1.7 4.3 4.3 1.7-4.3 1.7L11 15.5l-1.7-4.3L5 9.5l4.3-1.7z',
      'M17.5 14.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z',
    ],
  },
  compare: {
    paths: [
      'M5.5 5h2.5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
      'M10.75 9h2.5a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
      'M16 12.5h2.5a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H16a1 1 0 0 1-1-1v-4.5a1 1 0 0 1 1-1z',
    ],
  },
  commitment: {
    paths: ['M12 7.5V12l3 2'],
    circles: [[12, 12, 8.25]],
  },
  availability: {
    paths: ['M4 7.5h9', 'M18.5 7.5H20', 'M4 16.5h3.5', 'M12.5 16.5H20'],
    circles: [
      [15.75, 7.5, 2.25],
      [10, 16.5, 2.25],
    ],
  },
  bell: {
    paths: ['M6.5 16.5V11a5.5 5.5 0 1 1 11 0v5.5l1.5 2h-14z', 'M10 20.5a2.2 2.2 0 0 0 4 0'],
  },
  ai: {
    paths: [
      'M9 4v2.5',
      'M15 4v2.5',
      'M9 17.5V20',
      'M15 17.5V20',
      'M4 9h2.5',
      'M4 15h2.5',
      'M17.5 9H20',
      'M17.5 15H20',
      'M8.5 6.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
      'M12 9.25l.8 2 2 .75-2 .75-.8 2-.8-2-2-.75 2-.75z',
    ],
  },
  search: {
    paths: ['M15.75 15.75L20 20'],
    circles: [[10.75, 10.75, 6.25]],
  },
  help: {
    paths: ['M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8v.3'],
    circles: [[12, 12, 8.5]],
    dots: [[12, 16.75]],
  },
  logout: {
    paths: ['M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10', 'M15 8l4 4-4 4', 'M19 12H9.5'],
  },
  plus: { paths: ['M12 5.5v13', 'M5.5 12h13'] },
  more: { paths: ['M4.5 7h15', 'M4.5 12h15', 'M4.5 17h15'] },
  close: { paths: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'] },
  check: { paths: ['M5.5 12.5l4 4 9-9'] },
  'check-circle': {
    paths: ['M8.5 12.25l2.5 2.5 4.75-5'],
    circles: [[12, 12, 8.5]],
  },
  info: {
    paths: ['M12 11v5'],
    circles: [[12, 12, 8.5]],
    dots: [[12, 7.9]],
  },
  warn: {
    paths: ['M10.3 4.9a2 2 0 0 1 3.4 0l6.6 11.4a2 2 0 0 1-1.7 3H5.4a2 2 0 0 1-1.7-3z', 'M12 9.5v4'],
    dots: [[12, 16.4]],
  },
  error: {
    paths: ['M9.25 9.25l5.5 5.5', 'M14.75 9.25l-5.5 5.5'],
    circles: [[12, 12, 8.5]],
  },
  offline: {
    paths: [
      'M3.5 9a13 13 0 0 1 4.3-2.6',
      'M12 6a13 13 0 0 1 8.5 3',
      'M6.5 12.5a8 8 0 0 1 3-1.6',
      'M14.8 11.2a8 8 0 0 1 2.7 1.3',
      'M9.6 15.8a4 4 0 0 1 4.8 0',
      'M4 4l16 16',
    ],
    dots: [[12, 19]],
  },
  sync: {
    paths: [
      'M19.5 11A7.5 7.5 0 0 0 6 7.2',
      'M4.5 13A7.5 7.5 0 0 0 18 16.8',
      'M5.5 3.75V7.5h3.75',
      'M18.5 20.25V16.5h-3.75',
    ],
  },
  play: { paths: ['M8.5 5.75v12.5a.75.75 0 0 0 1.15.63l9.6-6.25a.75.75 0 0 0 0-1.26l-9.6-6.25a.75.75 0 0 0-1.15.63z'] },
  pause: { paths: ['M9 5.5v13', 'M15 5.5v13'] },
  flag: { paths: ['M5.5 20.5V4.5', 'M5.5 4.5h11l-2.2 4 2.2 4h-11'] },
  shrink: { paths: ['M4 12h5.5', 'M7 9l3 3-3 3', 'M20 12h-5.5', 'M17 9l-3 3 3 3'] },
  reschedule: { paths: ['M4.5 12a7.5 7.5 0 1 0 2.2-5.3', 'M4.5 4.5v3.75h3.75', 'M12 8.5V12l2.5 1.5'] },
  edit: { paths: ['M4.5 19.5h3.75L18.6 9.15a2.1 2.1 0 0 0-3-3L5.25 16.5z', 'M14.25 7.5l2.25 2.25'] },
  trash: { paths: ['M4.5 7h15', 'M9.5 7V4.75h5V7', 'M6.5 7l.9 12.25a1.5 1.5 0 0 0 1.5 1.25h6.2a1.5 1.5 0 0 0 1.5-1.25L17.5 7'] },
  expand: { paths: ['M4.5 9V4.5H9', 'M19.5 9V4.5H15', 'M4.5 15v4.5H9', 'M19.5 15v4.5H15'] },
  collapse: { paths: ['M9 4.5V9H4.5', 'M15 4.5V9h4.5', 'M9 19.5V15H4.5', 'M15 19.5V15h4.5'] },
  'arrow-left': { paths: ['M19 12H5.5', 'M10.5 7l-5 5 5 5'] },
  'arrow-right': { paths: ['M5 12h13.5', 'M13.5 7l5 5-5 5'] },
  'chevron-left': { paths: ['M14.5 6.5L9 12l5.5 5.5'] },
  'chevron-right': { paths: ['M9.5 6.5L15 12l-5.5 5.5'] },
  clock: { paths: ['M12 7.5V12l3 2'], circles: [[12, 12, 8.25]] },
  lock: {
    paths: [
      'M8 10.5V8a4 4 0 0 1 8 0v2.5',
      'M6.75 10.5h10.5a1.5 1.5 0 0 1 1.5 1.5v6.25a1.5 1.5 0 0 1-1.5 1.5H6.75a1.5 1.5 0 0 1-1.5-1.5V12a1.5 1.5 0 0 1 1.5-1.5z',
    ],
    dots: [[12, 15.1]],
  },
  pattern: { paths: ['M4.5 19.5h15', 'M7.5 16.5V12', 'M12 16.5V7.5', 'M16.5 16.5v-6'] },
  leaf: { paths: ['M5 19c0-8 5-13 14-14-1 9-6 14-14 14z', 'M5 19l7-7'] },
  layout: { paths: ['M5.5 4.5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1z', 'M11 4.5v15', 'M11 12h8.5'] },
  shield: { paths: ['M12 3.75l7 2.75v5.25c0 4.3-3 7.6-7 8.5-4-.9-7-4.2-7-8.5V6.5z', 'M9 12l2.25 2.25L15.5 10'] },
} as const satisfies Record<string, IconShape>;

export type IconName = keyof typeof ICONS;
