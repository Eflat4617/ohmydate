import type { Component } from 'vue';
import type { PanelComponentId } from '@ohmydate/ui-policy';
import ActiveSessionPanel from '../components/layout/ActiveSessionPanel.vue';
import CurrentTaskPanel from '../components/layout/CurrentTaskPanel.vue';
import DeadlineRiskPanel from '../components/layout/DeadlineRiskPanel.vue';
import NextUpPanel from '../components/layout/NextUpPanel.vue';
import RelatedNotesPanel from '../components/layout/RelatedNotesPanel.vue';
import ReviewPromptPanel from '../components/layout/ReviewPromptPanel.vue';

/**
 * Component Registry (07 §2): the only components a LayoutSpec can put on
 * screen. Page components (TodayPlan, FocusTimer, PlanningWorkspace,
 * NotesWorkspace) are the routed view itself; the frame renders them through
 * its slot. Anything else is not rendered.
 */
export const PANEL_REGISTRY: Readonly<Record<PanelComponentId, Component>> = {
  CurrentTaskCard: CurrentTaskPanel,
  NextUp: NextUpPanel,
  RelatedNotes: RelatedNotesPanel,
  DeadlineRiskPanel,
  ReviewPrompt: ReviewPromptPanel,
  ActiveSessionCard: ActiveSessionPanel,
};
