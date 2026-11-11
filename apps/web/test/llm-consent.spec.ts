/**
 * FU-54 (carried from FU-52R2/FU-52cR): the AI consent UI grants and revokes
 * consent through PATCH /me/settings with If-Match + Idempotency-Key, shows the
 * resulting state, and keeps the old state when the update fails.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia } from 'pinia';
import { nextTick } from 'vue';
import { isUuidV7Key, type User } from '../src/api';
import LlmSettingsView from '../src/views/LlmSettingsView.vue';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

interface SettingsCall {
  readonly body: unknown;
  readonly ifMatch: string | null;
  readonly key: string | null;
}

/** PATCH /me/settings that applies the consent like the API does. */
function settingsEndpoint(options: { fail?: boolean } = {}): SettingsCall[] {
  const calls: SettingsCall[] = [];
  server.use(
    http.patch('*/api/v1/me/settings', async ({ request }) => {
      const body = (await request.json()) as { llm?: { consent?: { granted?: boolean } } };
      calls.push({
        body,
        ifMatch: request.headers.get('If-Match'),
        key: request.headers.get('Idempotency-Key'),
      });
      if (options.fail === true) {
        return HttpResponse.json(
          { type: 'about:blank', title: 'Internal', status: 500, code: 'internal_error', detail: 'x' },
          { status: 500, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      const granted = body.llm?.consent?.granted === true;
      const next: User = {
        ...mockDb.user,
        version: mockDb.user.version + 1,
        llm: {
          ...(mockDb.user.llm ?? {}),
          consent: { granted, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' },
        },
      };
      mockDb.user = next;
      return HttpResponse.json(next as unknown as Record<string, unknown>, {
        headers: { ETag: `W/"${next.version}"` },
      });
    }),
  );
  return calls;
}

async function mountSettings(): Promise<VueWrapper> {
  const wrapper = mount(LlmSettingsView, {
    global: { plugins: [createPinia()] },
    attachTo: document.body,
  });
  await settle();
  await vi.waitFor(() => {
    expect(wrapper.find('h1').exists()).toBe(true);
  });
  return wrapper;
}

describe('AI consent settings (FU-54)', () => {
  beforeEach(() => {
    mockDb.user = { ...mockDb.user, llmProvider: 'deepseek' };
  });

  it('grants consent, shows it as on, then revokes it back to manual mode', async () => {
    const calls = settingsEndpoint();
    const wrapper = await mountSettings();
    expect(wrapper.text()).toContain('직접 작성 모드');
    expect(wrapper.text()).toContain('AI를 호출하지 않아요');

    await button(wrapper, 'AI 계획 도움 켜기').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('AI 계획 도움 켜짐');
    });
    expect(wrapper.text()).toContain('deepseek 사용에 동의했어요');
    expect(calls[0]?.body).toEqual({ llm: { consent: { granted: true } } });
    expect(calls[0]?.ifMatch).toBe('W/"1"');
    expect(isUuidV7Key(calls[0]?.key ?? '')).toBe(true);

    await button(wrapper, '동의 철회').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('AI 계획 도움이 꺼져 있어요');
    });
    expect(calls[1]?.body).toEqual({ llm: { consent: { granted: false } } });
    expect(calls[1]?.ifMatch).toBe('W/"2"');
    expect(calls[1]?.key).not.toBe(calls[0]?.key);
    expect(wrapper.findAll('button').some((item) => item.text().includes('AI 계획 도움 켜기'))).toBe(true);
    wrapper.unmount();
  });

  it('negative: a failed grant keeps consent off and says so', async () => {
    const calls = settingsEndpoint({ fail: true });
    const wrapper = await mountSettings();
    await button(wrapper, 'AI 계획 도움 켜기').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('AI 동의를 바꾸지 못했어요');
    });
    expect(calls).toHaveLength(1);
    expect(wrapper.text()).not.toContain('AI 계획 도움 켜짐');
    expect(wrapper.get('[role="alert"]').text()).toContain('AI 동의를 바꾸지 못했어요');
    wrapper.unmount();
  });

  it('negative: without the deepseek provider there is no consent control at all', async () => {
    mockDb.user = { ...mockDb.user, llmProvider: 'fake' };
    const calls = settingsEndpoint();
    const wrapper = await mountSettings();
    expect(wrapper.findAll('button').some((item) => item.text().includes('AI 계획 도움 켜기'))).toBe(false);
    expect(calls).toHaveLength(0);
    wrapper.unmount();
  });
});
