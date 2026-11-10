import type { Stats } from 'node:fs';
import type { ZodType } from 'zod';

export type { ZodType };
export type Fs = typeof import('node:fs');
export type Z = import('zod').Z;
export type S = Stats;

export const domain = 'domain';
