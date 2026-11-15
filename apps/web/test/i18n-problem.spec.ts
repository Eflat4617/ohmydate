import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { http, HttpResponse } from 'msw';
import { ApiError, apiErrorFromPayload } from '../src/api';
import { OfflineMutationError } from '../src/composables/useTaskActions';
import I18nT from '../src/i18n/I18nT';
import { apiErrorMessage, errorMessage, problemMessage, UserFacingError } from '../src/i18n/problem';
import { server } from '../src/mocks/server';
import { useAuthStore } from '../src/stores/auth';

describe('problem code → Korean message', () => {
  it('uses the code, not the English detail, for API problems', () => {
    const error = apiErrorFromPayload(409, {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'active_session_exists',
      detail: 'An active session already exists for this user',
    });
    expect(errorMessage(error)).toBe('이미 진행 중인 집중 세션이 있어요.');
    expect(errorMessage(error)).not.toContain('active session');
  });

  it('adds the Retry-After wait to rate limiting when the server sends one', () => {
    const limited = apiErrorFromPayload(
      429,
      { type: 'about:blank', title: 'Too many', status: 429, code: 'rate_limited' },
      { 'Retry-After': '30' },
    );
    expect(apiErrorMessage(limited)).toBe('요청이 너무 많아요. 30초 뒤에 다시 시도해 주세요.');
    const noHeader = apiErrorFromPayload(429, { type: 'about:blank', title: 'Too many', status: 429, code: 'rate_limited' });
    expect(apiErrorMessage(noHeader)).toBe(problemMessage('rate_limited'));
  });

  it('maps non-problem responses by HTTP status', () => {
    expect(apiErrorMessage(new ApiError(503, 'unknown', 'Request failed with status 503'))).toBe(
      problemMessage('internal_error'),
    );
    expect(apiErrorMessage(new ApiError(404, 'unknown', 'x'))).toBe(problemMessage('not_found'));
    expect(apiErrorMessage(new ApiError(418, 'unknown', 'x'))).toBe('요청을 처리하지 못했어요 (HTTP 418).');
    expect(apiErrorMessage(new ApiError(0, 'unknown', 'x'))).toBe(problemMessage('unknown'));
  });

  it('keeps localized client errors, explains network failures and falls back otherwise', () => {
    expect(errorMessage(new OfflineMutationError())).toBe('오프라인이에요. 다시 연결될 때까지 편집할 수 없어요.');
    expect(errorMessage(new UserFacingError('직접 만든 안내예요.'))).toBe('직접 만든 안내예요.');
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe(
      '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.',
    );
    // A developer error never leaks its English message (negative).
    expect(errorMessage(new Error('Today is not loaded'))).toBe('문제가 생겼어요. 다시 시도해 주세요.');
    expect(errorMessage('boom', '대체 문구')).toBe('대체 문구');
  });

  it('tells the user when the email or password is wrong instead of echoing the server', async () => {
    setActivePinia(createPinia());
    server.use(
      http.post(/\/api\/v1\/auth\/login$/, () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'Unauthorized', status: 401, code: 'unauthenticated', detail: 'Invalid credentials' },
          { status: 401, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const auth = useAuthStore();
    await expect(auth.login('someone@example.test', 'wrong')).rejects.toBeInstanceOf(ApiError);
    expect(auth.error).toBe('이메일 또는 비밀번호가 맞지 않아요.');
  });
});

describe('I18nT', () => {
  it('fills placeholders with slots and params without v-html', () => {
    const Host = defineComponent({
      render: () =>
        h('p', [
          h(I18nT, { keypath: 'conflict.detail' }, { version: () => h('strong', '7') }),
        ]),
    });
    const wrapper = mount(Host);
    expect(wrapper.text()).toBe('서버에 더 새로운 버전(7)이 있어요. 내 변경은 이전 버전을 기준으로 했어요.');
    expect(wrapper.get('strong').text()).toBe('7');
    expect(wrapper.html()).not.toContain('{version}');

    const withParams = mount(
      defineComponent({ render: () => h('li', [h(I18nT, { keypath: 'planSchedule.blockProblem', params: { index: 2 } })]) }),
    );
    // A placeholder with neither slot nor param stays visible (negative).
    expect(withParams.text()).toBe('블록 2: {message}');
  });
});
