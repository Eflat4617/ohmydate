import { type BrowserContext, type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import {
  STILL_CANVAS,
  canvasTodo,
  driver,
  expectStoredTask,
  login,
  openInbox,
  openTodoDetail,
  putDownTodo,
  record,
  waitForPlannerTask,
} from '../helpers/app';
import { getTask, listProjects, listTasks, type ProjectDto, type TaskDto } from '../helpers/planner';
import { readState } from '../helpers/state';

/**
 * E2E-9 (HOLO-06) — a folder's whole life on the real stack: web → planner
 * API → the system of record (`record`: Vikunja on the default target, the
 * Rust core's own store on `core` — helpers/driver.ts). A folder is a project, and removing one is the only place in
 * the 할 일 canvas that moves the owner's to-dos in bulk: every to-do in it
 * goes to the inbox first, and only an empty folder is archived
 * (`apps/web/src/composables/useFolderActions.ts`).
 *
 * The live backend is not the mock: once a project is archived it leaves the
 * project list, every write to a to-do inside it is refused, and those to-dos
 * leave the unfiltered task list. So this spec is driven through the canvas as
 * a person would, and every step is checked through the planner API and in
 * the system of record itself. (Where an archived project goes differs by
 * target — out of the list, or kept in it and marked: `driver.listsAsLive`.)
 *
 *   make a folder → file three to-dos, finish one of them → rename → reload
 *   → (offline: nothing is moved, nothing is archived) → 폴더 없애기 → 되돌리기
 *   → 폴더 없애기 again → reload → finish one of the to-dos in the inbox.
 */
const state = readState();

interface Mutation {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
}

/** Every write the page sends to the planner API, in the order it was answered. */
function recordMutations(page: Page): Mutation[] {
  const seen: Mutation[] = [];
  page.on('response', (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (request.method() === 'GET' || !url.pathname.startsWith('/api/v1/')) return;
    let body: unknown;
    try {
      body = request.postDataJSON() as unknown;
    } catch {
      body = request.postData();
    }
    seen.push({ method: request.method(), path: url.pathname.replace('/api/v1', ''), status: response.status(), body });
  });
  return seen;
}

function dish(page: Page, folderId: string) {
  return page.locator(`[data-folder-dish="${folderId}"]`);
}

/** The number a dish shows: its open to-dos. */
function dishCount(page: Page, folderId: string) {
  return dish(page, folderId).locator('[data-folder-count] > span[aria-hidden="true"]');
}

async function openFolderMenu(page: Page, folderId: string) {
  await page.locator(`[data-folder-menu-button="${folderId}"]`).click();
  const menu = page.locator(`[data-folder-menu="${folderId}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

/** 폴더 없애기 from the folder's menu: the question is asked, nothing is sent yet. */
async function askToRemove(page: Page, folderId: string, title: string) {
  const menu = await openFolderMenu(page, folderId);
  await menu.getByRole('menuitem', { name: '폴더 없애기' }).click();
  const dialog = page.getByRole('alertdialog', { name: `“${title}” 폴더를 없앨까요?` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('안에 있는 할 일은 지우지 않고 인박스로 옮겨요. 끝낸 것도 함께 옮겨요.');
  return dialog;
}

function isArchiveOf(folderId: string) {
  return (mutation: Mutation): boolean =>
    mutation.method === 'PATCH' &&
    mutation.path === `/projects/${folderId}` &&
    (mutation.body as { archived?: unknown } | null)?.archived === true;
}

/** Where the three to-dos are, by id, as the planner API says right now. */
async function placesOf(page: Page, ids: readonly string[]): Promise<TaskDto[]> {
  return Promise.all(ids.map((id) => getTask(page, state, id)));
}

async function goOffline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(true);
  await expect(page.getByText(/오프라인이에요\. 저장해 둔 데이터를 보여 드리고 있어요/)).toBeVisible();
  await expect(page.locator('[data-tasks-place] .offline-note')).toHaveText('오프라인 · 읽기 전용');
}

async function goOnline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(false);
  await expect(page.getByText(/오프라인이에요\. 저장해 둔 데이터를 보여 드리고 있어요/)).toBeHidden();
  await expect(page.locator('[data-tasks-place] .offline-note')).toHaveCount(0);
}

test.describe('E2E-9 — a folder’s life on the real stack (HOLO-06)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('a folder is made, filled, renamed, emptied into the inbox, brought back and removed for good', async ({ browser }) => {
    const suffix = Date.now().toString(36);
    const firstName = `겨울 여행 ${suffix}`;
    const folderName = `겨울 여행 준비 ${suffix}`;
    const openOne = `숙소 예약 ${suffix}`;
    const openTwo = `기차표 알아보기 ${suffix}`;
    const finished = `여권 찾기 ${suffix}`;

    const context = await browser.newContext(STILL_CANVAS);
    const page = await context.newPage();
    await login(page, state);
    await openInbox(page);
    const mutations = recordMutations(page);

    const inbox = (await listProjects(page, state)).find((project) => project.kind === 'inbox');
    expect(inbox, 'the owner has an inbox').toBeDefined();
    const inboxId = (inbox as ProjectDto).id;

    // ── Three to-dos are put down: they float on the open water (the inbox). ──
    const ids: string[] = [];
    for (const title of [openOne, openTwo, finished]) {
      await putDownTodo(page, title);
      await expect(canvasTodo(page, title)).toHaveAttribute('data-folder', 'inbox');
      const task = await waitForPlannerTask(page, state, title);
      ids.push(task.id);
    }
    const [openOneId, openTwoId, finishedId] = ids as [string, string, string];
    const finishedTask = await waitForPlannerTask(page, state, finished);

    // ── 폴더 만들기 ─────────────────────────────────────────────────────────
    await page.getByRole('button', { name: '폴더 만들기' }).click();
    const createDialog = page.getByRole('dialog', { name: '새 폴더' });
    await createDialog.getByLabel('폴더 이름').fill(firstName);
    const createdResponse = page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/projects',
    );
    await createDialog.getByRole('button', { name: '만들기' }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const folder = (await created.json()) as ProjectDto;
    expect(folder).toMatchObject({ title: firstName, kind: 'normal', archived: false });
    await expect(createDialog).toBeHidden();
    await expect(page.locator('.toast', { hasText: `“${firstName}” 폴더를 만들었어요.` })).toBeVisible();
    await expect(dish(page, folder.id)).toBeVisible();
    await expect(dishCount(page, folder.id)).toHaveText('0');
    expect((await listProjects(page, state)).find((project) => project.id === folder.id)).toMatchObject({
      title: firstName,
      archived: false,
    });
    expect(await record.folder(page, firstName)).toMatchObject({ title: firstName, archived: false });

    // ── Filing: two picked and sent with 폴더로 옮기기, one from its own detail. ──
    await canvasTodo(page, openOne).click({ modifiers: ['ControlOrMeta'] });
    await canvasTodo(page, openTwo).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('[data-canvas-selection-count]')).toHaveText('2개 고름');
    await page.locator('[data-canvas-selection-move]').click();
    const picker = page.getByRole('menu', { name: '폴더로 옮기기' });
    await picker.getByRole('menuitem', { name: firstName }).click();
    await expect(picker).toBeHidden();
    await expect(canvasTodo(page, openOne)).toHaveAttribute('data-folder', folder.id);
    await expect(canvasTodo(page, openTwo)).toHaveAttribute('data-folder', folder.id);

    const card = await openTodoDetail(page, finished);
    await card.getByLabel('폴더', { exact: true }).selectOption(folder.id);
    await expect(card).toBeHidden();
    await expect(canvasTodo(page, finished)).toHaveAttribute('data-folder', folder.id);
    await expect
      .poll(async () => (await listTasks(page, state, folder.id)).map((task) => task.id).sort(), {
        message: 'the three to-dos are in the folder on the server',
      })
      .toEqual([...ids].sort());
    await expect(dishCount(page, folder.id)).toHaveText('3');

    // One of them is finished inside the folder: it leaves the surface, and stays in the folder.
    const finishing = await openTodoDetail(page, finished);
    await finishing.getByRole('button', { name: `${finished} 완료로 표시` }).click();
    await expect(canvasTodo(page, finished)).toHaveCount(0);
    await expectStoredTask(page, finishedTask, { done: true });
    await expect(dishCount(page, folder.id)).toHaveText('2');
    expect(await getTask(page, state, finishedId)).toMatchObject({ status: 'done', projectId: folder.id });

    // ── 이름 바꾸기, in place ───────────────────────────────────────────────
    await page.locator(`[data-folder-name="${folder.id}"]`).click();
    const renameInput = page.locator(`[data-folder-rename="${folder.id}"]`);
    await expect(renameInput).toBeFocused();
    await renameInput.fill(folderName);
    const renamedResponse = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/projects/${folder.id}`,
    );
    await renameInput.press('Enter');
    const renamedAnswer = await renamedResponse;
    expect(renamedAnswer.status()).toBe(200);
    const renamed = (await renamedAnswer.json()) as ProjectDto;
    expect(renamed).toMatchObject({ id: folder.id, title: folderName, archived: false });
    expect(renamed.version).toBeGreaterThan(folder.version);
    await expect(page.locator(`[data-folder-name="${folder.id}"]`)).toHaveText(folderName);
    expect(await record.folder(page, folderName)).toMatchObject({ title: folderName, archived: false });
    expect(await record.folder(page, firstName)).toBeUndefined();

    // ── Reload: the name, what is in it and the count hold. ─────────────────
    await page.reload();
    await expect(page.locator('[data-todo-canvas]')).toBeVisible();
    await expect(page.locator(`[data-folder-name="${folder.id}"]`)).toHaveText(folderName);
    await expect(dishCount(page, folder.id)).toHaveText('2');
    await expect(canvasTodo(page, openOne)).toHaveAttribute('data-folder', folder.id);
    await expect(canvasTodo(page, openTwo)).toHaveAttribute('data-folder', folder.id);
    await expect(canvasTodo(page, finished)).toHaveCount(0);
    const filled = await listTasks(page, state, folder.id);
    expect(filled.map((task) => [task.title, task.status]).sort()).toEqual(
      [
        [openOne, 'todo'],
        [openTwo, 'todo'],
        [finished, 'done'],
      ].sort(),
    );

    // ── Negative: offline, nothing is moved and nothing is archived. ────────
    // The question was asked while online; the answer comes after the line dropped.
    const offlineDialog = await askToRemove(page, folder.id, folderName);
    await goOffline(context, page);
    const before = mutations.length;
    await offlineDialog.getByRole('button', { name: '폴더 없애기' }).click();
    await expect(offlineDialog).toBeHidden();
    await expect(page.locator('.toast', { hasText: '폴더를 없애지 못했어요. 다시 시도해 주세요.' })).toBeVisible();
    // …and while it stays offline the menu does not offer it at all.
    await expect(dish(page, folder.id)).toBeVisible();
    const offlineMenu = await openFolderMenu(page, folder.id);
    await expect(offlineMenu.getByRole('menuitem', { name: '폴더 없애기' })).toBeDisabled();
    await expect(offlineMenu.getByRole('menuitem', { name: '이름 바꾸기' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(mutations.slice(before), 'no write left the page while it was offline').toEqual([]);
    await goOnline(context, page);
    expect((await listProjects(page, state)).find((project) => project.id === folder.id)).toMatchObject({
      title: folderName,
      archived: false,
    });
    expect((await placesOf(page, ids)).map((task) => task.projectId)).toEqual([folder.id, folder.id, folder.id]);
    expect(await record.folder(page, folderName)).toMatchObject({ archived: false });

    // ── 폴더 없애기: everything out to the inbox first, then the archive. ───
    const removeDialog = await askToRemove(page, folder.id, folderName);
    const removeStart = mutations.length;
    await removeDialog.getByRole('button', { name: '폴더 없애기' }).click();
    const removedToast = page.locator('.toast', { hasText: `“${folderName}” 폴더를 없앴어요. 안에 있던 할 일은 인박스에 있어요.` });
    await expect(removedToast).toBeVisible({ timeout: 30_000 });
    await expect(removeDialog).toBeHidden();
    await expect(dish(page, folder.id)).toHaveCount(0);

    const removal = mutations.slice(removeStart);
    const archiveAt = removal.findIndex(isArchiveOf(folder.id));
    expect(archiveAt, 'the folder was archived').toBeGreaterThanOrEqual(0);
    expect(removal[archiveAt]?.status).toBe(200);
    // The one safe order: each of the three moves was answered before the archive was.
    const moves = removal.slice(0, archiveAt).filter((mutation) => mutation.method === 'PATCH' && mutation.path.startsWith('/tasks/'));
    expect(moves.map((mutation) => mutation.path).sort()).toEqual(ids.map((id) => `/tasks/${id}`).sort());
    expect(moves.map((mutation) => [mutation.status, mutation.body])).toEqual(moves.map(() => [200, { projectId: inboxId }]));
    expect(removal.filter((mutation) => mutation.method === 'DELETE')).toEqual([]);

    // Open and finished alike are in the inbox, none is deleted; the folder is gone and archived.
    const [afterRemove, projectsAfterRemove, tasksLeftInside, remoteAfterRemove] = await Promise.all([
      placesOf(page, ids),
      listProjects(page, state),
      listTasks(page, state, folder.id),
      record.folder(page, folderName),
    ]);
    expect(afterRemove.map((task) => [task.title, task.status, task.projectId, task.deletedAt])).toEqual([
      [openOne, 'todo', inboxId, undefined],
      [openTwo, 'todo', inboxId, undefined],
      [finished, 'done', inboxId, undefined],
    ]);
    expect(driver.listsAsLive(projectsAfterRemove, folder.id)).toBe(false);
    expect(tasksLeftInside).toEqual([]);
    expect(remoteAfterRemove).toMatchObject({ title: folderName, archived: true });
    await expect(canvasTodo(page, openOne)).toHaveAttribute('data-folder', 'inbox');
    await expect(canvasTodo(page, openTwo)).toHaveAttribute('data-folder', 'inbox');

    // ── 되돌리기 on the toast: the folder first, then its to-dos. ───────────
    const undoStart = mutations.length;
    await removedToast.getByRole('button', { name: '되돌리기' }).click();
    await expect(page.locator('.toast', { hasText: `“${folderName}” 폴더를 되돌렸어요.` })).toBeVisible({ timeout: 30_000 });
    await expect(dish(page, folder.id)).toBeVisible();
    await expect(page.locator(`[data-folder-name="${folder.id}"]`)).toHaveText(folderName);
    await expect(dishCount(page, folder.id)).toHaveText('2');
    await expect(canvasTodo(page, openOne)).toHaveAttribute('data-folder', folder.id);
    await expect(canvasTodo(page, openTwo)).toHaveAttribute('data-folder', folder.id);

    const undo = mutations.slice(undoStart);
    expect(undo[0]).toMatchObject({ method: 'PATCH', path: `/projects/${folder.id}`, status: 200, body: { archived: false } });
    expect(undo.slice(1).map((mutation) => [mutation.path, mutation.status, mutation.body]).sort()).toEqual(
      ids.map((id) => [`/tasks/${id}`, 200, { projectId: folder.id }]).sort(),
    );
    const [afterUndo, projectsAfterUndo, remoteAfterUndo] = await Promise.all([
      placesOf(page, ids),
      listProjects(page, state),
      record.folder(page, folderName),
    ]);
    expect(afterUndo.map((task) => [task.title, task.status, task.projectId, task.deletedAt])).toEqual([
      [openOne, 'todo', folder.id, undefined],
      [openTwo, 'todo', folder.id, undefined],
      [finished, 'done', folder.id, undefined],
    ]);
    expect(projectsAfterUndo.find((project) => project.id === folder.id)).toMatchObject({ title: folderName, archived: false });
    expect(remoteAfterUndo).toMatchObject({ archived: false });

    // ── Removed again, and left removed: a reload does not bring it back. ───
    const againDialog = await askToRemove(page, folder.id, folderName);
    const againStart = mutations.length;
    await againDialog.getByRole('button', { name: '폴더 없애기' }).click();
    await expect(page.locator('.toast', { hasText: `“${folderName}” 폴더를 없앴어요. 안에 있던 할 일은 인박스에 있어요.` })).toBeVisible({
      timeout: 30_000,
    });
    await expect(dish(page, folder.id)).toHaveCount(0);
    expect(mutations.slice(againStart).filter(isArchiveOf(folder.id)).map((mutation) => mutation.status)).toEqual([200]);

    await page.reload();
    await expect(page.locator('[data-todo-canvas]')).toBeVisible();
    await expect(canvasTodo(page, openOne)).toHaveAttribute('data-folder', 'inbox');
    await expect(canvasTodo(page, openTwo)).toHaveAttribute('data-folder', 'inbox');
    await expect(dish(page, folder.id)).toHaveCount(0);
    await expect(page.locator('[data-folder-dish]').filter({ hasText: folderName })).toHaveCount(0);
    expect(driver.listsAsLive(await listProjects(page, state), folder.id)).toBe(false);
    expect(await record.folder(page, folderName)).toMatchObject({ archived: true });
    const settled = await placesOf(page, ids);
    expect(settled.map((task) => [task.title, task.status, task.projectId, task.deletedAt])).toEqual([
      [openOne, 'todo', inboxId, undefined],
      [openTwo, 'todo', inboxId, undefined],
      [finished, 'done', inboxId, undefined],
    ]);
    // The unfiltered list — what the canvas reads — names all three.
    const everything = await listTasks(page, state);
    expect(ids.every((id) => everything.some((task) => task.id === id))).toBe(true);
    for (const task of settled) {
      expect((await record.task(page, task)).inInbox, `${task.title} is in the record's inbox`).toBe(true);
    }

    // The list view shows the finished one too, as a finished row of the inbox.
    await page.locator('[data-tasks-view-link="list"]').click();
    await expect(page.locator('.task-item', { hasText: finished }).getByText('완료', { exact: true })).toBeVisible();
    await page.locator('[data-tasks-view-link="canvas"]').click();
    await expect(page.locator('[data-todo-canvas]')).toBeVisible();

    // ── Still editable: one of them is finished from the inbox. ─────────────
    const last = await openTodoDetail(page, openOne);
    await last.getByRole('button', { name: `${openOne} 완료로 표시` }).click();
    await expect(canvasTodo(page, openOne)).toHaveCount(0);
    await expect
      .poll(async () => (await getTask(page, state, openOneId)).status, { message: 'the to-do is finished on the server' })
      .toBe('done');
    await expectStoredTask(page, await getTask(page, state, openOneId), { done: true });
    expect(await getTask(page, state, openTwoId)).toMatchObject({ status: 'todo', projectId: inboxId });

    await context.close();
  });
});
