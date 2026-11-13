import {
  COMMITMENT_SOURCES,
  COMMITMENT_WRITABLE_SOURCES,
  CalendarDayEventListQuerySchema,
  CalendarDayEventPageSchema,
  CommitmentCreateSchema,
  CommitmentPatchSchema,
  CommitmentSchema,
  GOOGLE_OAUTH_CALLBACK_PATH,
  GOOGLE_SYNC_ERROR_CODES,
  GoogleConnectResponseSchema,
  GoogleDisconnectQuerySchema,
  GoogleIntegrationSchema,
  GoogleIntegrationSettingsPutSchema,
  GoogleSyncResultSchema,
  contractRoutes,
  schemaRegistry,
} from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const OTHER_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';

const SETTINGS = {
  exportBlocks: true,
  exportCommitments: true,
  dailySummary: true,
  reminderMinutes: 10,
};

function integration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'connected',
    importAvailable: true,
    exportAvailable: true,
    calendars: [{ id: ID, name: '내 캘린더', primary: true, accessRole: 'owner', selected: true }],
    exportCalendarName: 'OhMyDate',
    settings: SETTINGS,
    lastSyncAt: '2026-11-13T00:00:00.000Z',
    lastError: null,
    version: 3,
    ...overrides,
  };
}

describe('GoogleIntegration', () => {
  const validate = compile(GoogleIntegrationSchema);

  test('accepts every status and the not-configured shape', () => {
    for (const status of ['not_configured', 'disconnected', 'connected', 'needs_reauth']) {
      expect(validate(integration({ status }))).toBe(true);
    }
    expect(
      validate(
        integration({
          status: 'not_configured',
          importAvailable: false,
          exportAvailable: false,
          calendars: [],
          exportCalendarName: null,
          lastSyncAt: null,
          version: 1,
        }),
      ),
    ).toBe(true);
  });

  test('lastError is a closed code, never free text', () => {
    for (const code of GOOGLE_SYNC_ERROR_CODES) {
      expect(validate(integration({ lastError: code }))).toBe(true);
    }
    expect(validate(integration({ lastError: 'Request had invalid authentication credentials' }))).toBe(
      false,
    );
  });

  test('rejects unknown status, unknown access role and extra fields', () => {
    expect(validate(integration({ status: 'pending' }))).toBe(false);
    expect(
      validate(
        integration({
          calendars: [{ id: ID, name: 'x', primary: false, accessRole: 'admin', selected: false }],
        }),
      ),
    ).toBe(false);
    expect(validate(integration({ refreshToken: 'x' }))).toBe(false);
    expect(validate(integration({ settings: { ...SETTINGS, accessToken: 'x' } }))).toBe(false);
  });

  test('reminderMinutes is 0..40320 or null', () => {
    expect(validate(integration({ settings: { ...SETTINGS, reminderMinutes: null } }))).toBe(true);
    expect(validate(integration({ settings: { ...SETTINGS, reminderMinutes: 0 } }))).toBe(true);
    expect(validate(integration({ settings: { ...SETTINGS, reminderMinutes: 40_320 } }))).toBe(true);
    expect(validate(integration({ settings: { ...SETTINGS, reminderMinutes: 40_321 } }))).toBe(false);
    expect(validate(integration({ settings: { ...SETTINGS, reminderMinutes: -1 } }))).toBe(false);
  });
});

describe('Google integration requests', () => {
  test('settings PUT is a full replacement with unique calendar ids', () => {
    const validate = compile(GoogleIntegrationSettingsPutSchema);
    expect(validate({ selectedCalendarIds: [ID, OTHER_ID], settings: SETTINGS })).toBe(true);
    expect(validate({ selectedCalendarIds: [], settings: SETTINGS })).toBe(true);
    expect(validate({ selectedCalendarIds: [ID, ID], settings: SETTINGS })).toBe(false);
    expect(validate({ selectedCalendarIds: ['primary'], settings: SETTINGS })).toBe(false);
    expect(validate({ selectedCalendarIds: [ID] })).toBe(false);
    expect(
      validate({ selectedCalendarIds: [], settings: { exportBlocks: true } }),
    ).toBe(false);
  });

  test('disconnect query accepts only the literal true/false flag', () => {
    const validate = compile(GoogleDisconnectQuerySchema);
    expect(validate({})).toBe(true);
    expect(validate({ removeExported: 'true' })).toBe(true);
    expect(validate({ removeExported: 'false' })).toBe(true);
    expect(validate({ removeExported: 'yes' })).toBe(false);
    expect(validate({ removeExported: true })).toBe(false);
  });

  test('connect response is a URI and sync result counts are non-negative integers', () => {
    expect(
      compile(GoogleConnectResponseSchema)({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      }),
    ).toBe(true);
    expect(compile(GoogleConnectResponseSchema)({ authorizationUrl: 'not a url' })).toBe(false);
    const validate = compile(GoogleSyncResultSchema);
    const result = {
      imported: { created: 1, updated: 0, removed: 2, dayEvents: 3 },
      exported: { created: 4, updated: 5, removed: 0 },
      lastSyncAt: '2026-11-13T00:00:00.000Z',
    };
    expect(validate(result)).toBe(true);
    expect(validate({ ...result, exported: { created: -1, updated: 0, removed: 0 } })).toBe(false);
  });
});

describe('calendar day events', () => {
  test('query needs both dates; items carry exclusive end dates and the google source', () => {
    const validateQuery = compile(CalendarDayEventListQuerySchema);
    expect(validateQuery({ from: '2026-11-01', to: '2026-11-30' })).toBe(true);
    expect(validateQuery({ from: '2026-11-01' })).toBe(false);
    expect(validateQuery({ from: '2026-11-01T00:00:00Z', to: '2026-11-30' })).toBe(false);

    const validatePage = compile(CalendarDayEventPageSchema);
    const item = {
      id: ID,
      title: '개천절',
      startDate: '2026-10-03',
      endDate: '2026-10-04',
      source: 'google',
      calendarName: '대한민국의 휴일',
    };
    expect(validatePage({ items: [item] })).toBe(true);
    expect(validatePage({ items: [{ ...item, calendarName: null }] })).toBe(true);
    expect(validatePage({ items: [{ ...item, source: 'manual' }] })).toBe(false);
    expect(validatePage({ items: [{ ...item, title: '' }] })).toBe(false);
    expect(validatePage({ items: [{ ...item, description: 'x' }] })).toBe(false);
  });
});

describe('commitment source google', () => {
  test('responses may carry source google', () => {
    expect(COMMITMENT_SOURCES).toContain('google');
    expect(
      compile(CommitmentSchema)({
        id: ID,
        ownerId: OTHER_ID,
        title: '치과',
        startAt: '2026-11-14T01:00:00.000Z',
        endAt: '2026-11-14T02:00:00.000Z',
        timeZone: 'Asia/Seoul',
        source: 'google',
        version: 1,
        createdAt: '2026-11-13T00:00:00.000Z',
        updatedAt: '2026-11-13T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  test('clients cannot create or patch a commitment into source google', () => {
    expect(COMMITMENT_WRITABLE_SOURCES).not.toContain('google');
    const create = {
      title: '치과',
      startAt: '2026-11-14T01:00:00.000Z',
      endAt: '2026-11-14T02:00:00.000Z',
      timeZone: 'Asia/Seoul',
    };
    expect(compile(CommitmentCreateSchema)({ ...create, source: 'manual' })).toBe(true);
    expect(compile(CommitmentCreateSchema)({ ...create, source: 'google' })).toBe(false);
    expect(compile(CommitmentPatchSchema)({ source: 'google' })).toBe(false);
    expect(compile(CommitmentPatchSchema)({ source: 'caldav' })).toBe(true);
  });
});

describe('integration route table', () => {
  test('the OAuth callback is not a contract operation; its path constant is exported', () => {
    expect(GOOGLE_OAUTH_CALLBACK_PATH).toBe('/integrations/google/callback');
    expect(contractRoutes.some((route) => route.path === GOOGLE_OAUTH_CALLBACK_PATH)).toBe(false);
  });

  test('the new DTOs are registered as OpenAPI components', () => {
    expect(schemaRegistry).toMatchObject({
      GoogleIntegration: GoogleIntegrationSchema,
      GoogleIntegrationSettingsPut: GoogleIntegrationSettingsPutSchema,
      GoogleSyncResult: GoogleSyncResultSchema,
      CalendarDayEventPage: CalendarDayEventPageSchema,
    });
  });
});
