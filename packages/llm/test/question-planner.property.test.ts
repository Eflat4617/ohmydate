import fc from 'fast-check';
import {
  OPTIONAL_INTAKE_FIELDS,
  REQUIRED_INTAKE_FIELDS,
  planQuestions,
  type IntakeField,
} from '@ohmydate/domain';

const ALL_FIELDS: IntakeField[] = [...REQUIRED_INTAKE_FIELDS, ...OPTIONAL_INTAKE_FIELDS];

const sampleValue = (field: IntakeField): unknown => {
  if (field === 'dueAt') return new Date('2026-11-20T14:59:00.000Z');
  if (field === 'currentProgress') return 0;
  if (field === 'availabilityConfirmed' || field === 'reviewNeeded') return false;
  if (field === 'priority') return 2;
  return `provided:${field}`;
};

/**
 * Property (05 §4): already-provided fields are removed from the question candidates.
 * This lives in the llm package because fast-check is a runtime import and the domain
 * package boundary forbids runtime external imports.
 */
test('already-provided fields are never asked (property)', () => {
  fc.assert(
    fc.property(fc.subarray(ALL_FIELDS), (provided) => {
      const known = Object.fromEntries(provided.map((field) => [field, sampleValue(field)])) as Partial<
        Record<IntakeField, unknown>
      >;
      const plan = planQuestions({ known });
      const asked = new Set(plan.questions.map((question) => question.field));
      return provided.every((field) => !asked.has(field));
    }),
    { numRuns: 200 },
  );
});

test('planned questions are unique and capped (property)', () => {
  fc.assert(
    fc.property(fc.subarray(ALL_FIELDS), (provided) => {
      const known = Object.fromEntries(provided.map((field) => [field, sampleValue(field)])) as Partial<
        Record<IntakeField, unknown>
      >;
      const plan = planQuestions({ known });
      const fields = plan.questions.map((question) => question.field);
      return fields.length <= 5 && new Set(fields).size === fields.length;
    }),
    { numRuns: 200 },
  );
});
