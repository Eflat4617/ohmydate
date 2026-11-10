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
    });
  }
});
