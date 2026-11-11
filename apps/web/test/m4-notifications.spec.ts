import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { plannerClient } from '../src/api';
import NotificationsPanel from '../src/components/NotificationsPanel.vue';
import { useOfflineStore } from '../src/stores/offline';
import { useToastStore } from '../src/stores/toast';
import { SEED_NOTIFICATION_ID, mockDb } from '../src/mocks/db';

describe('Notifications panel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists due notifications and dismisses them with If-Match and a fresh idempotency key', async () => {
    const pinia = createPinia();
    const toast = useToastStore(pinia);
    toast.clear();
    const wrapper = mount(NotificationsPanel, {
      props: { open: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });

    await vi.waitFor(() => expect(wrapper.text()).toContain('곧 마감되는 작업이 있어요'));
    await vi.waitFor(() => {
      expect(toast.toasts.some((item) => item.message === '곧 마감되는 작업이 있어요')).toBe(true);
    });

    const dismiss = vi.spyOn(plannerClient, 'dismissNotification');
    const item = wrapper
      .findAll('.notification-item')
      .find((entry) => entry.text().includes('곧 마감되는 작업이 있어요'));
    if (item === undefined) throw new Error('missing due notification row');
    const button = item.findAll('button').find((entry) => entry.text().includes('지우기'));
    if (button === undefined) throw new Error('missing dismiss button');
    await button.trigger('click');

    await vi.waitFor(() => {
      expect(mockDb.notifications.get(SEED_NOTIFICATION_ID)?.state).toBe('dismissed');
    });
    expect(dismiss).toHaveBeenCalledWith(SEED_NOTIFICATION_ID, expect.any(String), 1);
    expect(wrapper.text()).not.toContain('곧 마감되는 작업이 있어요');
    wrapper.unmount();
    toast.clear();
  });

  it('does not register push when the browser does not support it (feature-detect no-op)', async () => {
    const pinia = createPinia();
    const submit = vi.spyOn(plannerClient, 'createPushSubscription');
    const wrapper = mount(NotificationsPanel, {
      props: { open: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });

    await vi.waitFor(() => expect(wrapper.text()).toContain('푸시 알림'));
    const enable = wrapper.findAll('button').find((item) => item.text().includes('푸시 알림 켜기'));
    if (enable === undefined) throw new Error('missing push button');
    expect(enable.attributes('disabled')).toBeDefined();
    await enable.trigger('click');
    expect(submit).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('이 브라우저는 푸시를 지원하지 않아요.');
    wrapper.unmount();
  });

  it('does not request push permission or subscribe while offline', async () => {
    const pinia = createPinia();
    const offline = useOfflineStore(pinia);
    offline.setOnline(false);
    const requestPermission = vi.fn(async () => 'granted');
    const subscribe = vi.fn();
    vi.stubGlobal('Notification', { requestPermission });
    vi.stubGlobal('PushManager', function PushManager() {});
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => null),
            subscribe,
          },
        }),
      },
    });
    const createSubscription = vi.spyOn(plannerClient, 'createPushSubscription');

    const wrapper = mount(NotificationsPanel, {
      props: { open: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('푸시 알림'));
    const enable = wrapper.findAll('button').find((item) => item.text().includes('푸시 알림 켜기'));
    if (enable === undefined) throw new Error('missing push button');
    expect(enable.attributes('disabled')).toBeDefined();
    await enable.trigger('click');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();

    wrapper.unmount();
    vi.unstubAllGlobals();
    if (serviceWorkerDescriptor === undefined) {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    } else {
      Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
    }
  });

  it('re-checks online state after the push permission prompt is answered', async () => {
    const pinia = createPinia();
    const offline = useOfflineStore(pinia);
    const pendingPermission: { resolve: ((permission: 'granted') => void) | null } = {
      resolve: null,
    };
    const requestPermission = vi.fn(
      () =>
        new Promise<'granted'>((resolve) => {
          pendingPermission.resolve = resolve;
        }),
    );
    const subscribe = vi.fn();
    vi.stubGlobal('Notification', { requestPermission });
    vi.stubGlobal('PushManager', function PushManager() {});
    const serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: vi.fn(async () => null),
            subscribe,
          },
        }),
      },
    });
    const createSubscription = vi.spyOn(plannerClient, 'createPushSubscription');

    const wrapper = mount(NotificationsPanel, {
      props: { open: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('푸시 알림'));
    const enable = wrapper.findAll('button').find((item) => item.text().includes('푸시 알림 켜기'));
    if (enable === undefined) throw new Error('missing push button');
    expect(enable.attributes('disabled')).toBeUndefined();
    await enable.trigger('click');
    await vi.waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1));

    offline.setOnline(false);
    const grantPermission = pendingPermission.resolve;
    if (grantPermission === null) throw new Error('permission request was not made');
    grantPermission('granted');
    await vi.waitFor(() => expect(wrapper.text()).toContain('푸시 알림을 켜려면 인터넷에 연결해 주세요.'));
    expect(subscribe).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();

    wrapper.unmount();
    vi.unstubAllGlobals();
    if (serviceWorkerDescriptor === undefined) {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    } else {
      Object.defineProperty(navigator, 'serviceWorker', serviceWorkerDescriptor);
    }
  });

  it('exposes dialog and control roles (axe-lite)', async () => {
    const pinia = createPinia();
    const wrapper = mount(NotificationsPanel, {
      props: { open: true },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('곧 마감되는 작업이 있어요'));

    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-labelledby')).toBe('notifications-title');
    for (const element of wrapper.findAll('button')) {
      const accessible = element.attributes('aria-label') ?? element.text().trim();
      expect(accessible.length).toBeGreaterThan(0);
    }
    wrapper.unmount();
  });
});
