import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Temporal } from 'temporal-polyfill';
import type {
  Block,
  ScheduleInput,
  TaskDeficit,
  ViolationCode,
} from '../src/index.js';
import {
  computeAvailableSlots,
  deficit,
  generate,
  GENERATOR_VERSION,
  maxContiguousMin,
  slotTotalMin,
  taskRequiredMinutes,
  validate,
  validateInput,
} from '../src/index.js';

interface GoldenFixture {
  id: string;
  description: string;
  userTimeZone?: string;
  input: ScheduleInput;
  candidateBlocks: {
    valid: Block[] | null;
    invalid: Block[] | null;
  };
  expected: {
    slotTotalMin: number;
    slotIntervalCount: number;
    validViolationCodes: ViolationCode[];
    invalidViolationCodes: ViolationCode[];
    inputIssueCodes?: string[];
    deficit?: TaskDeficit & {
      total: {
        requiredMin: number;
        availableBeforeDueMin: number;
        deficitMin: number;
      };
    };
    noContiguousWindow?: boolean;
    userTimeZoneSlots?: Array<{ startPlain: string; endPlain: string }>;
  };
}

interface GeneratorExpectation {
  feasibleCount: number;
  deficitMin: number;
  reason?: string;
  maxDailyLoadMin?: number;
  reusesExistingBlock?: boolean;
}

/**
 * Expected generator behaviour per fixture. Feasible counts are the number of
 * returned (post-diversity) candidates that validate cleanly; the rest are
 * infeasible candidates that must still explain their violations.
 */
const GENERATOR_EXPECTATIONS: Record<string, GeneratorExpectation> = {
  G01: { feasibleCount: 0, deficitMin: 60, reason: 'no_contiguous_window' },
  G02: { feasibleCount: 1, deficitMin: 0 },
  G03: { feasibleCount: 1, deficitMin: 0 },
  G04: { feasibleCount: 2, deficitMin: 0, reusesExistingBlock: true },
  G05: { feasibleCount: 1, deficitMin: 0, maxDailyLoadMin: 120 },
  G06: { feasibleCount: 1, deficitMin: 0 },
  G07: { feasibleCount: 0, deficitMin: 60, reason: 'invalid_window' },
  G08: { feasibleCount: 1, deficitMin: 0 },
  G09: { feasibleCount: 0, deficitMin: 60, reason: 'insufficient_available_time' },
  G10: { feasibleCount: 1, deficitMin: 0 },
  G11: { feasibleCount: 0, deficitMin: 60, reason: 'insufficient_available_time' },
  G12: { feasibleCount: 1, deficitMin: 0 },
  G13: { feasibleCount: 0, deficitMin: 0, reason: 'no_contiguous_window' },
  G14: { feasibleCount: 1, deficitMin: 0 },
};

const goldenDir = fileURLToPath(new URL('./golden/', import.meta.url));
const fixtureFiles = readdirSync(goldenDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

function loadFixture(fileName: string): GoldenFixture {
  return JSON.parse(
    readFileSync(join(goldenDir, fileName), 'utf8'),
  ) as GoldenFixture;
}

function codesOf(violations: Array<{ code: string }>): string[] {
  return violations.map((violation) => violation.code).sort();
}

describe('golden cases G01-G14', () => {
  it('contains all fourteen fixtures', () => {
    expect(fixtureFiles).toHaveLength(14);
  });

  for (const fileName of fixtureFiles) {
    const fixture = loadFixture(fileName);

    it(`${fixture.id}: ${fixture.description}`, () => {
      const slots = computeAvailableSlots(fixture.input);

      expect(slotTotalMin(slots)).toBe(fixture.expected.slotTotalMin);
      expect(slots).toHaveLength(fixture.expected.slotIntervalCount);

      for (let index = 1; index < slots.length; index += 1) {
        const previous = slots[index - 1];
        const current = slots[index];
        if (previous === undefined || current === undefined) {
          continue;
        }
        expect(
          Temporal.Instant.from(previous.end).epochMilliseconds,
        ).toBeLessThanOrEqual(
          Temporal.Instant.from(current.start).epochMilliseconds,
        );
      }

      const repeated = computeAvailableSlots(fixture.input);
      expect(JSON.stringify(repeated)).toBe(JSON.stringify(slots));

      const issueCodes = validateInput(fixture.input)
        .map((issue) => issue.code)
        .sort();
      if (fixture.expected.inputIssueCodes === undefined) {
        expect(issueCodes).toEqual([]);
      } else {
        expect(issueCodes).toEqual([...fixture.expected.inputIssueCodes].sort());
      }

      if (fixture.candidateBlocks.valid !== null) {
        const validCodes = codesOf(
          validate(fixture.input, fixture.candidateBlocks.valid, {
            riskLevel: fixture.input.prefs.riskLevel,
          }),
        );
        expect(validCodes).toEqual(
          [...fixture.expected.validViolationCodes].sort(),
        );
      }

      if (fixture.candidateBlocks.invalid !== null) {
        const invalidCodes = codesOf(
          validate(fixture.input, fixture.candidateBlocks.invalid, {
            riskLevel: fixture.input.prefs.riskLevel,
          }),
        );
        expect(invalidCodes).toEqual(
          [...fixture.expected.invalidViolationCodes].sort(),
        );
      }

      if (fixture.expected.deficit !== undefined) {
        const report = deficit(fixture.input);
        const task = report.tasks.find(
          (entry) => entry.taskId === fixture.expected.deficit?.taskId,
        );
        expect(task).toEqual({
          taskId: fixture.expected.deficit.taskId,
          requiredMin: fixture.expected.deficit.requiredMin,
          availableBeforeDueMin: fixture.expected.deficit.availableBeforeDueMin,
          deficitMin: fixture.expected.deficit.deficitMin,
        });
        expect(report.riskLevel).toBe(fixture.input.prefs.riskLevel);
        expect(report.total).toEqual(fixture.expected.deficit.total);
      }

      if (
        fixture.expected.noContiguousWindow === true &&
        fixture.expected.userTimeZoneSlots === undefined
      ) {
        const task = fixture.input.tasks[0];
        expect(task).toBeDefined();
        if (task !== undefined) {
          expect(task.splittable).toBe(false);
          expect(maxContiguousMin(slots)).toBeLessThan(
            taskRequiredMinutes(task, fixture.input.prefs.riskLevel),
          );
        }
      }

      if (fixture.expected.userTimeZoneSlots !== undefined) {
        expect(fixture.userTimeZone).toBeDefined();
        const timeZone = fixture.userTimeZone as string;
        const plainSlots = slots.map((slot) => ({
          startPlain: Temporal.Instant.from(slot.start)
            .toZonedDateTimeISO(timeZone)
            .toPlainDateTime()
            .toString(),
          endPlain: Temporal.Instant.from(slot.end)
            .toZonedDateTimeISO(timeZone)
            .toPlainDateTime()
            .toString(),
        }));
        expect(plainSlots).toEqual(fixture.expected.userTimeZoneSlots);
      }

      const generatorExpectation = GENERATOR_EXPECTATIONS[fixture.id];
      expect(generatorExpectation).toBeDefined();
      if (generatorExpectation === undefined) {
        return;
      }

      const generated = generate(fixture.input, {
        policies: ['front_loaded', 'balanced', 'focus_blocked'],
        seed: fixture.input.seed,
      });

      expect(generated.candidates.length).toBeGreaterThanOrEqual(1);
      expect(generated.candidates.length).toBeLessThanOrEqual(3);
      expect(generated.candidates.filter((candidate) => candidate.feasible)).toHaveLength(
        generatorExpectation.feasibleCount,
      );

      const hashes = new Set(
        generated.candidates.map((candidate) => candidate.inputHash),
      );
      expect(hashes.size).toBe(1);
      const [hash] = [...hashes];
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      for (const candidate of generated.candidates) {
        expect(candidate.generatorVersion).toBe(GENERATOR_VERSION);
        expect(candidate.deficitMin).toBe(generatorExpectation.deficitMin);
        expect(candidate.metrics.deficitMin).toBe(candidate.deficitMin);
        expect(candidate.explanation.length).toBeGreaterThan(0);

        if (candidate.feasible) {
          expect(
            validate(fixture.input, candidate.blocks, {
              riskLevel: fixture.input.prefs.riskLevel,
            }),
          ).toEqual([]);
        } else {
          expect(
            candidate.blocks.length === 0 ||
              validate(fixture.input, candidate.blocks, {
                riskLevel: fixture.input.prefs.riskLevel,
              }).length > 0 ||
              candidate.explanation.some((line) =>
                line.includes('Input rejected'),
              ),
          ).toBe(true);
        }

        if (generatorExpectation.maxDailyLoadMin !== undefined) {
          expect(candidate.metrics.maxDailyLoadMin).toBeLessThanOrEqual(
            generatorExpectation.maxDailyLoadMin,
          );
        }
      }

      if (generatorExpectation.reason !== undefined) {
        expect(
          generated.candidates.some((candidate) =>
            candidate.explanation.some((line) =>
              line.includes(generatorExpectation.reason as string),
            ),
          ),
        ).toBe(true);
      }

      if (generatorExpectation.reusesExistingBlock === true) {
        expect(
          generated.candidates.some(
            (candidate) => candidate.metrics.changedBlocks === 0,
          ),
        ).toBe(true);
      }

      if (fixture.id === 'G14') {
        expect(generated.candidates).toHaveLength(1);
        expect(generated.diversityNote).toBeDefined();
        expect(generated.diversityNote).toContain('distinct');
      }

      if (fixture.id === 'G12') {
        const repeated = generate(fixture.input, {
          policies: ['front_loaded', 'balanced', 'focus_blocked'],
          seed: fixture.input.seed,
        });
        expect(JSON.stringify(repeated)).toBe(JSON.stringify(generated));
      }
    });
  }
});
