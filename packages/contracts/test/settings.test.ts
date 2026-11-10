import { UserSettingsPatchSchema } from '../src/index.js';
import { compile } from './ajv.js';

test('settings timeZone accepts the same named zones as the domain', () => {
  const validate = compile(UserSettingsPatchSchema);
  for (const timeZone of ['Asia/Seoul', 'America/New_York', 'UTC']) {
    expect({ timeZone, valid: validate({ timeZone }) }).toEqual({ timeZone, valid: true });
  }
});

test('settings timeZone rejects offset-only and unknown identifiers', () => {
  const validate = compile(UserSettingsPatchSchema);
  for (const timeZone of ['+09:00', 'Mars/Olympus', '']) {
    expect({ timeZone, valid: validate({ timeZone }) }).toEqual({ timeZone, valid: false });
  }
});
