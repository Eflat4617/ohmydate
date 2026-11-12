---
version: 1
slug: "src-views-todayview-vue"
primary_target: "src/views/TodayView.vue"
related_targets: ["src/styles.css","src/components/AppShell.vue"]
---

# Surface brief: OhMyDate web app

Scope: every screen of `apps/web` (views, components, `src/styles`), redesigned as one replacement visual world. Visitor mode: Operate. First surface: Today (`/today`).

Audience and job: the owner alone, on a laptop browser, several times a day. Find the next block, see where it sits in the day, start a focus session, review it. Less often: plan a goal, compare three schedule candidates, paint weekly availability.

Content and constraints: every string, route, shortcut, `data-*` hook, class the tests read and accessible name stays. No network fonts. Light and dark follow the OS. WCAG 2.2 AA.

Chosen direction: 텐미닛 플래너, taken by the user on the decision page on 2026-11-13 (the pick card), with no steer. Chosen sketch: `.impeccable/mocks/decision/model-pick.html`. What the user called wrong with the old look: the cream and green pairing, the same card stack on every screen, sparse density, and rounded cards with shadows and pill badges. A result fails if it barely differs from the old one or if decoration distracts from the schedule.

Memorable moment: the day drawn as ten-minute cells, with highlighter over the planned time.

Unresolved: how the phone is used; whether to ship a Hangul font file rather than rely on the installed one.

## Direction contract

THESIS: The app is a page from a Korean ten-minute study planner: time is drawn as cells and planned time is highlighted. It refuses the calm-dashboard arrangement of white rounded cards, soft shadows and tinted pills on a cream ground.

OWN-WORLD: Cool white paper, a cyan-grey ruled grid in two weights, pen-black ink for text, 2px section rules and filled primary controls. Fluorescent highlighter fills carry state and time series: yellow for current, next and selected, mint for done, pink for caution, then sky, lilac and orange for further series. Red pen for danger, blue pen for links and focus. Square pen-drawn boxes, 3 to 4px corners, no shadow, no card. A state is a highlighted word, never a pill.

STORY: The owner reads the next block first, sees where it falls in the day, and starts it. Planning screens read as worksheets and tables, settings as plain forms, so each kind of screen looks like its job.

FIRST VIEWPORT: 1440 by 900. Left rail, 216px, paper with a right hairline: wordmark, ink-filled 새 작업, nav with a yellow highlighter stroke under the current item. Centre: 오늘 at 30px weight 800 with the date beside it and an outlined 오늘 계획 수락 at the right, over a 2px ink rule; a row of figures (계획, 여유, 블록, 위험도 with the level highlighted); then the block list, each row a pen box, the title (the next one highlighted yellow, 20px), its time line and its actions, with one ink-filled 집중 시작. Right, about 500px: 타임테이블, hour rows of six ten-minute cells under a 2px ink rule, each planned block filled in its highlighter, a legend below.

SIGNATURE INTERACTION: time cells fill with highlighter. Availability is painted by dragging over cells, focus progress fills ten-minute cells as time passes, and the Today timetable shows every block as a fill.

MOTION: state only. A highlighter stroke draws from the left when an item becomes current or selected (the nav's current item, the next block's title, the picked schedule candidate). An overlay that opens and a layout switch fade in by opacity, because the layout tests require it (07 §2.3). Nothing else moves, and reduced motion removes all of it.

FORM: a Korean study planner with a ten-minute timetable, position 1 of 7 on the grounded list, chosen by the user over the assigned index 3. seed:4ada1e5707e6a072

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
