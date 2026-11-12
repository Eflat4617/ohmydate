// Generated from packages/contracts/openapi.json by `pnpm gen:api`.
// Do not edit by hand; regenerate and commit instead.
export interface paths {
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create a session cookie */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Destroy the current session */
        post: operations["logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/availability": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read availability rules, exceptions and preferences */
        get: operations["getAvailability"];
        /** Replace availability and bump availability_version */
        put: operations["putAvailability"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/commitments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List commitments expanded within a bounded period */
        get: operations["listCommitments"];
        put?: never;
        /** Create a fixed commitment */
        post: operations["createCommitment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/commitments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Soft delete a commitment */
        delete: operations["deleteCommitment"];
        options?: never;
        head?: never;
        /** Update a commitment */
        patch: operations["updateCommitment"];
        trace?: never;
    };
    "/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List or search notes
         * @description Newest first. q searches title and body with the PostgreSQL simple text-search configuration (prefix match per token, ranked by ts_rank; Korean has no stemmer). targetKind + targetId must be given together and list notes linked to that goal/project/task.
         */
        get: operations["listDocuments"];
        put?: never;
        /**
         * Create a note
         * @description bodyMd is raw Markdown (at most 65 536 characters) and is stored and returned as-is; the API never renders HTML. llmAllowed defaults to false. Optional links must target the caller's own goals, projects or tasks (404 otherwise).
         */
        post: operations["createDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a note */
        get: operations["getDocument"];
        put?: never;
        post?: never;
        /**
         * Soft-delete a note
         * @description A deleted note is no longer listed, readable or sent to the AI.
         */
        delete: operations["deleteDocument"];
        options?: never;
        head?: never;
        /**
         * Update a note
         * @description Editing title or body changes the stored body hash, so earlier AI usage entries become stale and later calls send the new sections.
         */
        patch: operations["updateDocument"];
        trace?: never;
    };
    "/documents/{id}/ai-usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List AI calls that received sections of this note
         * @description Newest first. Ids, section hashes and byte counts only; the sent text is never stored (05 §12).
         */
        get: operations["listDocumentAiUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents/{id}/links": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Link a note to a goal, project or task
         * @description If-Match is the note version. The target must belong to the caller (404 otherwise); a duplicate link or more than 50 links is 422.
         */
        post: operations["addDocumentLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents/{id}/links/{linkId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a note link
         * @description If-Match is the note version. Returns the note without the link.
         */
        delete: operations["removeDocumentLink"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/estimation/feedback/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Exclude or re-include one learning feedback item */
        patch: operations["patchEstimationFeedback"];
        trace?: never;
    };
    "/estimation/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the personal estimation profile ("내 패턴")
         * @description Returns per-template/task-kind log-ratio statistics with sample count, confidence and method, plus feedback items whose outlier/exclusion state can be toggled. Priors and shrinkage use k=5 and |z|>2.5 outlier rejection (05 §6).
         */
        get: operations["getEstimationProfile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/estimation:reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reset learned estimation corrections by scope
         * @description Resets personal corrections for one template (scope="template", templateId required) or all templates (scope="all") per 05 §6 and 08 §2.10. Returns the refreshed estimation profile.
         */
        post: operations["resetEstimation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a data export
         * @description Queues a zip export (JSON + Markdown + attachments) and returns 202 with the export id.
         */
        post: operations["createExport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/exports/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read export state and download URL
         * @description Metadata is always readable. downloadUrl appears only when state is ready and expires at expiresAt.
         */
        get: operations["getExport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start an intake interview */
        post: operations["createIntakeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read an intake session (resume support) */
        get: operations["getIntakeSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}/answers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit interview answers */
        post: operations["answerIntakeQuestions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the decomposition draft */
        get: operations["getIntakeDraft"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Edit the decomposition draft */
        patch: operations["updateIntakeDraft"];
        trace?: never;
    };
    "/intake-sessions/{id}/draft:approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Approve the draft and create tasks */
        post: operations["approveIntakeDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}/type-confirmation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Confirm or reject a similar task type */
        post: operations["confirmIntakeType"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}:cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel an intake interview */
        post: operations["cancelIntakeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}:manual": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Switch the intake interview to manual mode */
        post: operations["enterManualIntakeMode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}:pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pause an intake interview (state becomes needs_input; other states return 409) */
        post: operations["pauseIntakeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/intake-sessions/{id}:resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume a paused intake interview (needs_input restores the previous state) */
        post: operations["resumeIntakeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read the current user */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update user settings */
        patch: operations["updateMySettings"];
        trace?: never;
    };
    "/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List notifications */
        get: operations["listNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/notifications/{id}:dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Dismiss a notification */
        post: operations["dismissNotification"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Generate plan candidates for a goal or task set */
        post: operations["createPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a plan with its candidates and metrics */
        get: operations["getPlan"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans/{id}/candidates/{cid}:approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve a candidate as a new plan version
         * @description The same pre-flight mapping as preview-edit applies: edited blocks outside the persisted plan horizon or plan task scope fail with 422 validation_failed errors[{path: "/editedBlocks/<i>", message}], while scheduler findings use 422 constraint_violation with violations[].
         */
        post: operations["approvePlanCandidate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans/{id}/candidates/{cid}:preview-edit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Validate an edited candidate without side effects
         * @description Pre-flight validation maps edited blocks outside the persisted plan horizon or outside the plan task scope to 422 validation_failed with errors[{path: "/blocks/<i>", message}] before H1-H8 validation. If-Match is the plan resource version W/"<n>"; a stale version returns 412 version_conflict. Validator findings are returned in the 200 PreviewEditResponse, not as a 422.
         */
        post: operations["previewPlanCandidateEdit"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/plans/{id}:regenerate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Regenerate candidates after a stale availability version
         * @description Candidates are regenerated against the plan's original persisted horizon and time zone; the response Plan DTO echoes them unchanged.
         */
        post: operations["regeneratePlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List projects */
        get: operations["listProjects"];
        put?: never;
        /** Create a project */
        post: operations["createProject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/push-subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register a browser push subscription
         * @description The endpoint must be HTTPS. Key material is encrypted at rest and never returned.
         */
        post: operations["createPushSubscription"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/push-subscriptions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a push subscription */
        delete: operations["deletePushSubscription"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/replan-proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List replan proposals, optionally filtered by state */
        get: operations["listReplanProposals"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/replan-proposals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a replan proposal */
        get: operations["getReplanProposal"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/replan-proposals/{id}:approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve a replan proposal as a new plan version
         * @description Reuses the plan-approval atomicity contract (08 §2.4): If-Match is the user-wide availability version W/"availability:<n>", and one transaction re-reads availability and locked blocks, re-runs validation, supersedes prior blocks and creates a plan version with createdBy="replan". A stale snapshot returns 412 availability_changed, a non-pending proposal returns 409 proposal_state_conflict, and scheduler findings return 422 constraint_violation{violations[]}.
         */
        post: operations["approveReplanProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/replan-proposals/{id}:reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reject a replan proposal and suppress the same reason for 24 h
         * @description If-Match is the proposal resource version W/"<n>". A rejected proposal records a replan_suppression(owner, reason, until = now + 24 h) so the same reason is not proposed again inside the window (05 §11).
         */
        post: operations["rejectReplanProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/replan-proposals:request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Request a user-initiated replan proposal
         * @description Creates a pending proposal for a plan with trigger kind user_request. When the same reason is inside its 24 h post-rejection suppression window, or the owner already received two proposals today, the response is 409 replan_suppressed with Retry-After seconds until the next allowed attempt.
         */
        post: operations["requestReplanProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/schedule-blocks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List active approved blocks overlapping a calendar range (FU-51)
         * @description The range must be positive and at most 366 days (422 validation_failed otherwise). Only non-superseded approved blocks of the owner are returned.
         */
        get: operations["listScheduleBlocks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/schedule-blocks/{id}:lock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Lock an approved future block so replanning never moves it (FU-71)
         * @description If-Match is the block version W/"<ScheduleBlock.version>". Only a planned block of an active plan that has not started yet (startAt >= now) can be locked or unlocked; a started, done, skipped, moved or superseded block (or a block of a non-active plan) is 409 illegal_transition. The block times never change. A change increments the block version and the plan revision (Plan.version = Today.version), so Today actions, plan previews and Today proposals pinned to the previous revision answer 412/409 and must be refreshed. Repeating the call on a block that already has the requested state returns it unchanged. Unknown or foreign blocks are 404. A locked block is kept as-is by replan, regenerate and Today actions (06 §7).
         */
        post: operations["lockScheduleBlock"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/schedule-blocks/{id}:unlock": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Unlock an approved future block so the next replan may move it (FU-71)
         * @description If-Match is the block version W/"<ScheduleBlock.version>". Only a planned block of an active plan that has not started yet (startAt >= now) can be locked or unlocked; a started, done, skipped, moved or superseded block (or a block of a non-active plan) is 409 illegal_transition. The block times never change. A change increments the block version and the plan revision (Plan.version = Today.version), so Today actions, plan previews and Today proposals pinned to the previous revision answer 412/409 and must be refreshed. Repeating the call on a block that already has the requested state returns it unchanged. Unknown or foreign blocks are 404. An unlocked block is movable by the next replan.
         */
        post: operations["unlockScheduleBlock"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List focus sessions, optionally filtered by state */
        get: operations["listSessions"];
        put?: never;
        /**
         * Start a focus session
         * @description Only one active session per owner exists. A second with the same owner returns 409 active_session_exists.
         */
        post: operations["createSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a focus session (resume/deep-link support) */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit end-of-session feedback
         * @description Creates a task completion review and estimation feedback. The optional note is personal text and is never logged.
         */
        post: operations["reviewSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}:complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete a focus session */
        post: operations["completeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}:pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pause a focus session */
        post: operations["pauseSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/sessions/{id}:resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume a paused focus session */
        post: operations["resumeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List tasks */
        get: operations["listTasks"];
        put?: never;
        /** Create a task */
        post: operations["createTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a task */
        get: operations["getTask"];
        put?: never;
        post?: never;
        /** Soft delete a task */
        delete: operations["deleteTask"];
        options?: never;
        head?: never;
        /** Update a task */
        patch: operations["updateTask"];
        trace?: never;
    };
    "/tasks/{id}/dependencies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Add a task dependency */
        post: operations["createTaskDependency"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks/{id}:complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete a task */
        post: operations["completeTask"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/tasks/{id}:promote-description": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Copy the task description into a new linked note once
         * @description If-Match is the task version. Reads the current provider description once, converts editor HTML to plain Markdown (the result never contains a tag), creates a note linked to the task and never syncs afterwards (07 §7). An empty description is 422; a task that already has a live promoted note is 409 illegal_transition.
         */
        post: operations["promoteTaskDescription"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search task templates */
        get: operations["listTaskTemplates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/templates/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read a task template */
        get: operations["getTaskTemplate"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/today": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read today blocks, slack and risk */
        get: operations["getToday"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/today/proposals/{id}:approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Apply a today shrink/reschedule proposal
         * @description If-Match is the user-wide availability version W/"availability:<n>", the same lock as plan approval (08 §2.4). The proposal persists its base plan version and availability snapshot; in one transaction the server re-reads availability and locked blocks, re-runs validation, supersedes prior active blocks and creates a new plan version. A stale snapshot returns 412 availability_changed.
         */
        post: operations["approveTodayProposal"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/today:accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept today's recommended blocks
         * @description If-Match pins the active plan revision echoed as Today.version. The request is idempotent and returns the accepted Today view.
         */
        post: operations["acceptToday"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/today:reschedule": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Propose moving today blocks */
        post: operations["rescheduleToday"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/today:shrink": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Propose a shorter block for today */
        post: operations["shrinkToday"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ApprovePlanRequest: {
            editedBlocks?: {
                /** Format: date-time */
                endAt: string;
                /** Format: date-time */
                startAt: string;
                /** Format: uuid */
                taskId: string;
            }[];
        };
        Availability: {
            exceptions: {
                /** Format: date */
                date: string;
                endLocal?: string;
                kind: "off" | "extra";
                startLocal?: string;
            }[];
            prefs: {
                breakAfterMin: number;
                breakMin: number;
                dayEndLocal: string;
                dayStartLocal: string;
                maxDailyFocusMin: number;
                riskLevel: "p50" | "p90";
            };
            rules: {
                endLocal: string;
                kind: "work" | "focus";
                startLocal: string;
                weekday: number;
            }[];
            /** Format: iana-time-zone */
            timeZone: string;
            version: number;
        };
        AvailabilityException: {
            /** Format: date */
            date: string;
            endLocal?: string;
            kind: "off" | "extra";
            startLocal?: string;
        };
        AvailabilityPreferences: {
            breakAfterMin: number;
            breakMin: number;
            dayEndLocal: string;
            dayStartLocal: string;
            maxDailyFocusMin: number;
            riskLevel: "p50" | "p90";
        };
        AvailabilityPut: {
            exceptions: {
                /** Format: date */
                date: string;
                endLocal?: string;
                kind: "off" | "extra";
                startLocal?: string;
            }[];
            prefs: {
                breakAfterMin: number;
                breakMin: number;
                dayEndLocal: string;
                dayStartLocal: string;
                maxDailyFocusMin: number;
                riskLevel: "p50" | "p90";
            };
            rules: {
                endLocal: string;
                kind: "work" | "focus";
                startLocal: string;
                weekday: number;
            }[];
            /** Format: iana-time-zone */
            timeZone: string;
        };
        AvailabilityRule: {
            endLocal: string;
            kind: "work" | "focus";
            startLocal: string;
            weekday: number;
        };
        Commitment: {
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            endAt: string;
            /** Format: uuid */
            id: string;
            occurrences?: {
                /** Format: uuid */
                commitmentId: string;
                /** Format: date-time */
                endAt: string;
                /** Format: date-time */
                startAt: string;
            }[];
            /** Format: uuid */
            ownerId: string;
            rrule?: string;
            source: "manual" | "caldav" | "vikunja";
            /** Format: date-time */
            startAt: string;
            /** Format: iana-time-zone */
            timeZone: string;
            title: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        CommitmentCreate: {
            /** Format: date-time */
            endAt: string;
            rrule?: string;
            source?: "manual" | "caldav" | "vikunja";
            /** Format: date-time */
            startAt: string;
            /** Format: iana-time-zone */
            timeZone: string;
            title: string;
        };
        CommitmentListQuery: {
            cursor?: string;
            /** Format: date-time */
            from: string;
            limit?: number;
            /** Format: date-time */
            to: string;
        };
        CommitmentOccurrence: {
            /** Format: uuid */
            commitmentId: string;
            /** Format: date-time */
            endAt: string;
            /** Format: date-time */
            startAt: string;
        };
        CommitmentPage: {
            items: {
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                endAt: string;
                /** Format: uuid */
                id: string;
                occurrences?: {
                    /** Format: uuid */
                    commitmentId: string;
                    /** Format: date-time */
                    endAt: string;
                    /** Format: date-time */
                    startAt: string;
                }[];
                /** Format: uuid */
                ownerId: string;
                rrule?: string;
                source: "manual" | "caldav" | "vikunja";
                /** Format: date-time */
                startAt: string;
                /** Format: iana-time-zone */
                timeZone: string;
                title: string;
                /** Format: date-time */
                updatedAt: string;
                version: number;
            }[];
            nextCursor: string | null;
        };
        CommitmentPatch: {
            /** Format: date-time */
            endAt?: string;
            rrule?: string | null;
            source?: "manual" | "caldav" | "vikunja";
            /** Format: date-time */
            startAt?: string;
            /** Format: iana-time-zone */
            timeZone?: string;
            title?: string;
        };
        ContextDocument: {
            bodyMd: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            id: string;
            links: {
                /** Format: date-time */
                createdAt: string;
                /** Format: uuid */
                documentId: string;
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                targetId: string;
                targetKind: "goal" | "project" | "task";
            }[];
            llmAllowed: boolean;
            /** Format: uuid */
            ownerId: string;
            sensitivity: "P1" | "P2";
            source: "manual" | "task_description";
            /** Format: uuid */
            sourceTaskId?: string;
            title: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        ContextDocumentCreate: {
            bodyMd?: string;
            links?: {
                /** Format: uuid */
                targetId: string;
                targetKind: "goal" | "project" | "task";
            }[];
            llmAllowed?: boolean;
            sensitivity?: "P1" | "P2";
            title: string;
        };
        ContextDocumentIdParams: {
            /** Format: uuid */
            id: string;
        };
        ContextDocumentListQuery: {
            cursor?: string;
            limit?: number;
            q?: string;
            /** Format: uuid */
            targetId?: string;
            targetKind?: "goal" | "project" | "task";
        };
        ContextDocumentPage: {
            items: {
                bodyMd: string;
                /** Format: date-time */
                createdAt: string;
                /** Format: uuid */
                id: string;
                links: {
                    /** Format: date-time */
                    createdAt: string;
                    /** Format: uuid */
                    documentId: string;
                    /** Format: uuid */
                    id: string;
                    /** Format: uuid */
                    targetId: string;
                    targetKind: "goal" | "project" | "task";
                }[];
                llmAllowed: boolean;
                /** Format: uuid */
                ownerId: string;
                sensitivity: "P1" | "P2";
                source: "manual" | "task_description";
                /** Format: uuid */
                sourceTaskId?: string;
                title: string;
                /** Format: date-time */
                updatedAt: string;
                version: number;
            }[];
            nextCursor: string | null;
        };
        ContextDocumentPatch: {
            bodyMd?: string;
            llmAllowed?: boolean;
            sensitivity?: "P1" | "P2";
            title?: string;
        };
        DecompositionDraft: {
            assumptions: string[];
            evidence?: {
                kind: "fact" | "inference";
                source: {
                    /** Format: uuid */
                    docId: string;
                    /** @constant */
                    kind: "note";
                    sectionHash: string;
                };
                statement: string;
                stepKeys: string[];
                /** Format: date-time */
                updatedAt: string;
            }[];
            questionsRemaining: string[];
            steps: {
                deliverable: string;
                dependsOn: string[];
                doneCriteria: string;
                estimate: {
                    p50Minutes: number;
                    p90Minutes: number;
                };
                key: string;
                kind: "prep" | "work" | "review" | "buffer";
                splittable: boolean;
                title: string;
            }[];
        };
        DecompositionDraftPatch: {
            assumptions?: string[];
            questionsRemaining?: string[];
            steps?: {
                deliverable: string;
                dependsOn: string[];
                doneCriteria: string;
                estimate: {
                    p50Minutes: number;
                    p90Minutes: number;
                };
                key: string;
                kind: "prep" | "work" | "review" | "buffer";
                splittable: boolean;
                title: string;
            }[];
        };
        DecompositionEstimate: {
            p50Minutes: number;
            p90Minutes: number;
        };
        DecompositionEvidence: {
            kind: "fact" | "inference";
            source: {
                /** Format: uuid */
                docId: string;
                /** @constant */
                kind: "note";
                sectionHash: string;
            };
            statement: string;
            stepKeys: string[];
            /** Format: date-time */
            updatedAt: string;
        };
        DecompositionStep: {
            deliverable: string;
            dependsOn: string[];
            doneCriteria: string;
            estimate: {
                p50Minutes: number;
                p90Minutes: number;
            };
            key: string;
            kind: "prep" | "work" | "review" | "buffer";
            splittable: boolean;
            title: string;
        };
        DiversityNoteItem: {
            code: "diversity_dropped" | "diversity_distinct" | "replan_bound_exceeded";
            params: {
                [key: string]: string | number;
            };
        };
        DocumentLink: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            documentId: string;
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            targetId: string;
            targetKind: "goal" | "project" | "task";
        };
        DocumentLinkCreate: {
            /** Format: uuid */
            targetId: string;
            targetKind: "goal" | "project" | "task";
        };
        DocumentLinkParams: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            linkId: string;
        };
        EstimationFeedback: {
            actualFocusMin: number;
            estimatedP50: number;
            quality: "ok" | "outlier" | "excluded";
            /** Format: uuid */
            taskId: string;
        };
        EstimationFeedbackIdParams: {
            /** Format: uuid */
            id: string;
        };
        EstimationFeedbackPatch: {
            excluded: boolean;
        };
        EstimationProfile: {
            confidence: number;
            /** Format: date-time */
            generatedAt: string;
            groups: {
                confidence: number;
                dimension: "template" | "kind";
                key: string;
                method: string;
                sampleCount: number;
                stats: {
                    logRatioMean: number;
                    logRatioStdDev: number;
                    p50Ratio: number;
                    p90Ratio: number;
                    sampleCount: number;
                };
                taskKind?: "prep" | "work" | "review" | "buffer";
                /** Format: uuid */
                templateId?: string;
            }[];
            items: {
                actualFocusMin: number;
                /** Format: date-time */
                createdAt: string;
                estimatedP50: number;
                excluded: boolean;
                /** Format: uuid */
                feedbackId: string;
                quality: "ok" | "outlier" | "excluded";
                ratio: number;
                /** Format: uuid */
                taskId: string;
                taskKind?: "prep" | "work" | "review" | "buffer";
                /** Format: uuid */
                templateId?: string;
                version: number;
                zScore: number;
            }[];
            method: string;
            outlierZThreshold: number;
            sampleCount: number;
            shrinkageK: number;
        };
        EstimationProfileGroup: {
            confidence: number;
            dimension: "template" | "kind";
            key: string;
            method: string;
            sampleCount: number;
            stats: {
                logRatioMean: number;
                logRatioStdDev: number;
                p50Ratio: number;
                p90Ratio: number;
                sampleCount: number;
            };
            taskKind?: "prep" | "work" | "review" | "buffer";
            /** Format: uuid */
            templateId?: string;
        };
        EstimationProfileItem: {
            actualFocusMin: number;
            /** Format: date-time */
            createdAt: string;
            estimatedP50: number;
            excluded: boolean;
            /** Format: uuid */
            feedbackId: string;
            quality: "ok" | "outlier" | "excluded";
            ratio: number;
            /** Format: uuid */
            taskId: string;
            taskKind?: "prep" | "work" | "review" | "buffer";
            /** Format: uuid */
            templateId?: string;
            version: number;
            zScore: number;
        };
        EstimationRatioStats: {
            logRatioMean: number;
            logRatioStdDev: number;
            p50Ratio: number;
            p90Ratio: number;
            sampleCount: number;
        };
        /** @description Reset personal estimation corrections for one template or all. templateId is required when scope is "template" (422 validation_failed otherwise). */
        EstimationReset: {
            scope: "template" | "all";
            /** Format: uuid */
            templateId?: string;
        };
        ExplanationItem: {
            code: "policy_summary" | "placement_summary" | "constraints_satisfied" | "infeasible_summary" | "heuristic_insufficient_available_time" | "heuristic_no_contiguous_window" | "heuristic_estimate_not_grid_aligned" | "heuristic_estimate_below_grid" | "heuristic_session_bounds_infeasible" | "unplaced_minutes" | "capacity_deficit" | "replan_bound_exceeded" | "input_rejected" | "input_invalid_time_zone" | "input_invalid_horizon_instant" | "input_horizon_not_increasing" | "input_horizon_too_long" | "input_invalid_now" | "input_duplicate_task" | "input_invalid_estimate" | "input_invalid_buffer" | "input_invalid_session_minutes" | "input_invalid_session_bounds" | "input_invalid_task_window_instant" | "input_task_window_empty" | "input_invalid_preference" | "input_unknown_dependency" | "input_dependency_cycle" | "input_invalid_weekday" | "input_invalid_availability_window" | "input_invalid_exception_date" | "input_exception_partial_window" | "input_invalid_exception_window" | "input_commitment_invalid_instant" | "input_commitment_end_before_start" | "input_commitment_too_long" | "input_unknown_block_task" | "input_invalid_block_instant" | "input_block_sub_millisecond" | "input_block_off_grid" | "input_block_end_before_start" | "input_block_too_long" | "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
            params: {
                [key: string]: string | number;
            };
        };
        Export: {
            /** Format: date-time */
            createdAt: string;
            /** Format: uri */
            downloadUrl?: string;
            /** Format: date-time */
            expiresAt?: string;
            failureReason?: string;
            /** Format: uuid */
            id: string;
            sizeBytes?: number;
            state: "queued" | "running" | "ready" | "failed";
        };
        ExportIdParams: {
            /** Format: uuid */
            id: string;
        };
        ExportStartResponse: {
            /** Format: uuid */
            exportId: string;
        };
        IntakeAnswer: {
            action: "answer" | "skip" | "idk";
            questionKey: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
            questionText?: string;
            skipped: boolean;
            value?: string | number | boolean | string[] | null;
        };
        IntakeAnswersRequest: {
            answers: ({
                /** @constant */
                action: "answer";
                questionKey: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
                value: string | number | boolean | string[] | null;
            } | {
                /** @constant */
                action: "skip";
                questionKey: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
            } | {
                /** @constant */
                action: "idk";
                questionKey: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
            })[];
        };
        IntakeAssumption: {
            field: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
            reason: "skip" | "idk" | "unanswered";
            value: string;
        };
        IntakeDetectedType: {
            classification: "new" | "similar";
            confidence: number;
            missingRequired: ("deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded")[];
            reasons: string[];
            /** Format: uuid */
            templateId?: string;
        };
        IntakeError: {
            code: string;
            message: string;
        };
        IntakeInput: {
            availabilityConfirmed?: boolean;
            currentProgress?: number | string;
            deliverable?: string;
            description?: string;
            /** Format: date-time */
            dueAt?: string;
            estimatedScope?: "small" | "medium" | "large";
            maxFocusMinutes?: number;
            prerequisites?: string | number | boolean | string[] | null;
            priority?: number;
            reviewNeeded?: boolean;
            title: string;
        };
        IntakeSession: {
            answers?: {
                action: "answer" | "skip" | "idk";
                questionKey: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
                questionText?: string;
                skipped: boolean;
                value?: string | number | boolean | string[] | null;
            }[];
            assumptions?: {
                field: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
                reason: "skip" | "idk" | "unanswered";
                value: string;
            }[];
            /** Format: date-time */
            createdAt: string;
            detectedType?: {
                classification: "new" | "similar";
                confidence: number;
                missingRequired: ("deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded")[];
                reasons: string[];
                /** Format: uuid */
                templateId?: string;
            };
            draft?: {
                assumptions: string[];
                evidence?: {
                    kind: "fact" | "inference";
                    source: {
                        /** Format: uuid */
                        docId: string;
                        /** @constant */
                        kind: "note";
                        sectionHash: string;
                    };
                    statement: string;
                    stepKeys: string[];
                    /** Format: date-time */
                    updatedAt: string;
                }[];
                questionsRemaining: string[];
                steps: {
                    deliverable: string;
                    dependsOn: string[];
                    doneCriteria: string;
                    estimate: {
                        p50Minutes: number;
                        p90Minutes: number;
                    };
                    key: string;
                    kind: "prep" | "work" | "review" | "buffer";
                    splittable: boolean;
                    title: string;
                }[];
            };
            error?: {
                code: string;
                message: string;
            };
            /** Format: uuid */
            goalId?: string;
            /** Format: uuid */
            id: string;
            input: {
                availabilityConfirmed?: boolean;
                currentProgress?: number | string;
                deliverable?: string;
                description?: string;
                /** Format: date-time */
                dueAt?: string;
                estimatedScope?: "small" | "medium" | "large";
                maxFocusMinutes?: number;
                prerequisites?: string | number | boolean | string[] | null;
                priority?: number;
                reviewNeeded?: boolean;
                title: string;
            };
            manual: boolean;
            /** Format: uuid */
            ownerId: string;
            questions?: {
                choices: [
                    "answer",
                    "skip",
                    "idk"
                ];
                field: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
                prompt: string;
                required: boolean;
            }[];
            round: number;
            state: "created" | "type_detection" | "clarification" | "needs_input" | "decomposition" | "feasibility_check" | "plan_proposals" | "awaiting_approval" | "scheduled" | "cancelled" | "failed";
            /** Format: uuid */
            templateId?: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        IntakeSessionCreate: {
            /** Format: uuid */
            goalId?: string;
            input: {
                availabilityConfirmed?: boolean;
                currentProgress?: number | string;
                deliverable?: string;
                description?: string;
                /** Format: date-time */
                dueAt?: string;
                estimatedScope?: "small" | "medium" | "large";
                maxFocusMinutes?: number;
                prerequisites?: string | number | boolean | string[] | null;
                priority?: number;
                reviewNeeded?: boolean;
                title: string;
            };
        };
        IntakeSessionIdParams: {
            /** Format: uuid */
            id: string;
        };
        IntakeTypeConfirmation: {
            /** @constant */
            similar: true;
            /** Format: uuid */
            templateId: string;
        } | {
            /** @constant */
            similar: false;
        };
        LlmBudget: {
            dailyUsd: number;
            monthlyUsd: number;
        };
        LlmConsent: {
            /** Format: date-time */
            at: string;
            granted: boolean;
            provider: string;
        };
        LlmSettings: {
            budget?: {
                dailyUsd: number;
                monthlyUsd: number;
            };
            consent?: {
                /** Format: date-time */
                at: string;
                granted: boolean;
                provider: string;
            };
        };
        LoginRequest: {
            /** Format: email */
            email: string;
            password: string;
        };
        NoteAiUsage: {
            /** Format: uuid */
            agentRunId: string;
            bodyHash: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            documentId: string;
            documentVersion: number;
            /** Format: uuid */
            id: string;
            model: string;
            promptIdVersion: string;
            provider: string;
            purpose: string;
            sectionHashes: string[];
            sentBytes: number;
            stale: boolean;
            status: "pending" | "succeeded" | "failed" | "budget_exceeded";
        };
        NoteAiUsageListQuery: {
            cursor?: string;
            limit?: number;
        };
        NoteAiUsagePage: {
            items: {
                /** Format: uuid */
                agentRunId: string;
                bodyHash: string;
                /** Format: date-time */
                createdAt: string;
                /** Format: uuid */
                documentId: string;
                documentVersion: number;
                /** Format: uuid */
                id: string;
                model: string;
                promptIdVersion: string;
                provider: string;
                purpose: string;
                sectionHashes: string[];
                sentBytes: number;
                stale: boolean;
                status: "pending" | "succeeded" | "failed" | "budget_exceeded";
            }[];
            nextCursor: string | null;
        };
        Notification: {
            channel: "in_app" | "push";
            dedupeKey: string;
            /** Format: uuid */
            id: string;
            kind: "due_soon" | "deadline_risk" | "schedule_conflict" | "session_reminder" | "daily_summary" | "replan_proposal";
            /** Format: date-time */
            scheduledAt: string;
            /** Format: date-time */
            sentAt?: string;
            state: "scheduled" | "sent" | "dismissed" | "failed" | "expired";
            version: number;
        };
        NotificationIdParams: {
            /** Format: uuid */
            id: string;
        };
        NotificationPage: {
            items: {
                channel: "in_app" | "push";
                dedupeKey: string;
                /** Format: uuid */
                id: string;
                kind: "due_soon" | "deadline_risk" | "schedule_conflict" | "session_reminder" | "daily_summary" | "replan_proposal";
                /** Format: date-time */
                scheduledAt: string;
                /** Format: date-time */
                sentAt?: string;
                state: "scheduled" | "sent" | "dismissed" | "failed" | "expired";
                version: number;
            }[];
            nextCursor: string | null;
        };
        NotificationQuery: {
            cursor?: string;
            limit?: number;
            state?: "scheduled" | "sent" | "dismissed" | "failed" | "expired";
        };
        PageProject: {
            items: {
                archived: boolean;
                /** Format: date-time */
                createdAt: string;
                /** Format: uuid */
                id: string;
                kind: "inbox" | "normal";
                /** Format: uuid */
                ownerId: string;
                title: string;
                /** Format: date-time */
                updatedAt: string;
                version: number;
            }[];
            nextCursor: string | null;
        };
        PageTask: {
            items: {
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                deletedAt?: string;
                dependsOn: string[];
                description?: string;
                /** Format: date-time */
                dueAt?: string;
                external: {
                    externalId: string;
                    /** @constant */
                    provider: "vikunja";
                }[];
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                ownerId: string;
                priority: number;
                /** Format: uuid */
                projectId: string;
                session?: {
                    maxMinutes: number;
                    minMinutes: number;
                };
                splittable: boolean;
                status: "todo" | "in_progress" | "done";
                title: string;
                /** Format: date-time */
                updatedAt: string;
                version: number;
            }[];
            nextCursor: string | null;
        };
        PageTaskTemplate: {
            items: {
                confidence: number;
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                deletedAt?: string;
                /** Format: uuid */
                id: string;
                name: string;
                /** Format: uuid */
                ownerId: string;
                source: "user" | "system";
                stats: {
                    meanRatio?: number;
                    p90Ratio?: number;
                    sampleCount?: number;
                };
                steps: {
                    deliverable: string;
                    dependsOn: string[];
                    doneCriteria: string;
                    estimate: {
                        p50Minutes: number;
                        p90Minutes: number;
                    };
                    key: string;
                    kind: "prep" | "work" | "review" | "buffer";
                    splittable: boolean;
                    title: string;
                }[];
                /** Format: date-time */
                updatedAt: string;
                version: number;
            }[];
            nextCursor: string | null;
        };
        Plan: {
            availabilityVersion: number;
            candidates: {
                blocks: {
                    /** Format: date-time */
                    endAt: string;
                    /** Format: date-time */
                    startAt: string;
                    /** Format: uuid */
                    taskId: string;
                }[];
                capacityDeficitMin: number;
                deficitMin: number;
                diversityNote?: string;
                diversityNoteItems?: {
                    code: "diversity_dropped" | "diversity_distinct" | "replan_bound_exceeded";
                    params: {
                        [key: string]: string | number;
                    };
                }[];
                explanation: string[];
                explanationItems?: {
                    code: "policy_summary" | "placement_summary" | "constraints_satisfied" | "infeasible_summary" | "heuristic_insufficient_available_time" | "heuristic_no_contiguous_window" | "heuristic_estimate_not_grid_aligned" | "heuristic_estimate_below_grid" | "heuristic_session_bounds_infeasible" | "unplaced_minutes" | "capacity_deficit" | "replan_bound_exceeded" | "input_rejected" | "input_invalid_time_zone" | "input_invalid_horizon_instant" | "input_horizon_not_increasing" | "input_horizon_too_long" | "input_invalid_now" | "input_duplicate_task" | "input_invalid_estimate" | "input_invalid_buffer" | "input_invalid_session_minutes" | "input_invalid_session_bounds" | "input_invalid_task_window_instant" | "input_task_window_empty" | "input_invalid_preference" | "input_unknown_dependency" | "input_dependency_cycle" | "input_invalid_weekday" | "input_invalid_availability_window" | "input_invalid_exception_date" | "input_exception_partial_window" | "input_invalid_exception_window" | "input_commitment_invalid_instant" | "input_commitment_end_before_start" | "input_commitment_too_long" | "input_unknown_block_task" | "input_invalid_block_instant" | "input_block_sub_millisecond" | "input_block_off_grid" | "input_block_end_before_start" | "input_block_too_long" | "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
                    params: {
                        [key: string]: string | number;
                    };
                }[];
                feasible: boolean;
                generatorVersion: string;
                /** Format: uuid */
                id: string;
                inputHash: string;
                metrics: {
                    avgDailyLoadMin: number;
                    capacityDeficitMin: number;
                    changedBlocks: number;
                    contextSwitches: number;
                    deficitMin: number;
                    maxDailyLoadMin: number;
                    minSlackMin: number;
                    p90CoverageRatio: number;
                    totalFocusMin: number;
                };
                policy: "front_loaded" | "balanced" | "focus_blocked";
            }[];
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            currentVersionId?: string;
            horizon: {
                /** Format: date-time */
                end: string;
                /** Format: date-time */
                start: string;
            };
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            ownerId: string;
            scope: {
                /** Format: uuid */
                goalId: string;
            } | {
                taskIds: string[];
            };
            status: "draft" | "active" | "superseded";
            /** Format: iana-time-zone */
            timeZone: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        PlanBlock: {
            /** Format: date-time */
            endAt: string;
            /** Format: date-time */
            startAt: string;
            /** Format: uuid */
            taskId: string;
        };
        PlanCandidate: {
            blocks: {
                /** Format: date-time */
                endAt: string;
                /** Format: date-time */
                startAt: string;
                /** Format: uuid */
                taskId: string;
            }[];
            capacityDeficitMin: number;
            deficitMin: number;
            diversityNote?: string;
            diversityNoteItems?: {
                code: "diversity_dropped" | "diversity_distinct" | "replan_bound_exceeded";
                params: {
                    [key: string]: string | number;
                };
            }[];
            explanation: string[];
            explanationItems?: {
                code: "policy_summary" | "placement_summary" | "constraints_satisfied" | "infeasible_summary" | "heuristic_insufficient_available_time" | "heuristic_no_contiguous_window" | "heuristic_estimate_not_grid_aligned" | "heuristic_estimate_below_grid" | "heuristic_session_bounds_infeasible" | "unplaced_minutes" | "capacity_deficit" | "replan_bound_exceeded" | "input_rejected" | "input_invalid_time_zone" | "input_invalid_horizon_instant" | "input_horizon_not_increasing" | "input_horizon_too_long" | "input_invalid_now" | "input_duplicate_task" | "input_invalid_estimate" | "input_invalid_buffer" | "input_invalid_session_minutes" | "input_invalid_session_bounds" | "input_invalid_task_window_instant" | "input_task_window_empty" | "input_invalid_preference" | "input_unknown_dependency" | "input_dependency_cycle" | "input_invalid_weekday" | "input_invalid_availability_window" | "input_invalid_exception_date" | "input_exception_partial_window" | "input_invalid_exception_window" | "input_commitment_invalid_instant" | "input_commitment_end_before_start" | "input_commitment_too_long" | "input_unknown_block_task" | "input_invalid_block_instant" | "input_block_sub_millisecond" | "input_block_off_grid" | "input_block_end_before_start" | "input_block_too_long" | "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
                params: {
                    [key: string]: string | number;
                };
            }[];
            feasible: boolean;
            generatorVersion: string;
            /** Format: uuid */
            id: string;
            inputHash: string;
            metrics: {
                avgDailyLoadMin: number;
                capacityDeficitMin: number;
                changedBlocks: number;
                contextSwitches: number;
                deficitMin: number;
                maxDailyLoadMin: number;
                minSlackMin: number;
                p90CoverageRatio: number;
                totalFocusMin: number;
            };
            policy: "front_loaded" | "balanced" | "focus_blocked";
        };
        PlanCandidateParams: {
            /** Format: uuid */
            cid: string;
            /** Format: uuid */
            id: string;
        };
        PlanCreate: {
            horizon: {
                /** Format: date-time */
                end: string;
                /** Format: date-time */
                start: string;
            };
            policies?: ("front_loaded" | "balanced" | "focus_blocked")[];
            scope: {
                /** Format: uuid */
                goalId: string;
            } | {
                taskIds: string[];
            };
        };
        PlanHorizon: {
            /** Format: date-time */
            end: string;
            /** Format: date-time */
            start: string;
        };
        PlanIdParams: {
            /** Format: uuid */
            id: string;
        };
        PlanMetrics: {
            avgDailyLoadMin: number;
            capacityDeficitMin: number;
            changedBlocks: number;
            contextSwitches: number;
            deficitMin: number;
            maxDailyLoadMin: number;
            minSlackMin: number;
            p90CoverageRatio: number;
            totalFocusMin: number;
        };
        PlanScope: {
            /** Format: uuid */
            goalId: string;
        } | {
            taskIds: string[];
        };
        PlanVersion: {
            availabilityVersion: number;
            blocks: {
                /** Format: date-time */
                endAt: string;
                /** Format: uuid */
                id: string;
                locked: boolean;
                /** Format: uuid */
                planVersionId: string;
                /** Format: date-time */
                startAt: string;
                status: "planned" | "done" | "skipped" | "moved" | "superseded";
                /** Format: uuid */
                taskId: string;
                version: number;
            }[];
            /** Format: uuid */
            candidateId?: string;
            /** Format: date-time */
            createdAt: string;
            createdBy: "user" | "replan";
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            planId: string;
            reason?: string;
            seq: number;
            version: number;
        };
        PlannedQuestion: {
            choices: [
                "answer",
                "skip",
                "idk"
            ];
            field: "deliverable" | "dueAt" | "estimatedScope" | "currentProgress" | "availabilityConfirmed" | "prerequisites" | "priority" | "maxFocusMinutes" | "reviewNeeded";
            prompt: string;
            required: boolean;
        };
        PreviewEditRequest: {
            blocks: {
                /** Format: date-time */
                endAt: string;
                /** Format: date-time */
                startAt: string;
                /** Format: uuid */
                taskId: string;
            }[];
        };
        PreviewEditResponse: {
            deficitMin: number;
            feasible: boolean;
            violations: {
                code: "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8";
                message: string;
                messageCode?: "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
                params?: {
                    [key: string]: string | number;
                };
                /** Format: uuid */
                taskId?: string;
            }[];
        };
        Problem: {
            code: "validation_failed" | "version_conflict" | "availability_changed" | "constraint_violation" | "idempotency_mismatch" | "provider_unavailable" | "llm_unavailable" | "budget_exceeded" | "dependency_cycle" | "illegal_transition" | "approval_in_progress" | "not_found" | "forbidden" | "rate_limited" | "unauthenticated" | "idempotency_in_progress" | "active_session_exists" | "session_state_conflict" | "replan_suppressed" | "proposal_state_conflict" | "internal_error";
            detail?: string;
            errors?: {
                message: string;
                path: string;
            }[];
            status: number;
            title: string;
            traceId?: string;
            /** Format: uri */
            type: string;
            violations?: {
                code: "H1" | "H2" | "H3" | "H4" | "H5" | "H6" | "H7" | "H8";
                message: string;
                messageCode?: "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
                params?: {
                    [key: string]: string | number;
                };
                /** Format: uuid */
                taskId?: string;
            }[];
        };
        Project: {
            archived: boolean;
            /** Format: date-time */
            createdAt: string;
            /** Format: uuid */
            id: string;
            kind: "inbox" | "normal";
            /** Format: uuid */
            ownerId: string;
            title: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        ProjectCreate: {
            title: string;
        };
        ProjectPatch: {
            archived?: boolean;
            title?: string;
        };
        PushSubscription: {
            /** Format: date-time */
            createdAt: string;
            deviceLabel?: string;
            /** Format: uri */
            endpoint: string;
            /** Format: uuid */
            id: string;
            version: number;
        };
        PushSubscriptionCreate: {
            deviceLabel?: string;
            /** Format: uri */
            endpoint: string;
            keys: {
                auth: string;
                p256dh: string;
            };
        };
        PushSubscriptionIdParams: {
            /** Format: uuid */
            id: string;
        };
        PushSubscriptionKeys: {
            auth: string;
            p256dh: string;
        };
        ReplanApproveRequest: {
            editedBlocks?: {
                /** Format: date-time */
                endAt: string;
                /** Format: date-time */
                startAt: string;
                /** Format: uuid */
                taskId: string;
            }[];
        };
        ReplanBefore: {
            blocks: {
                /** Format: date-time */
                endAt: string;
                /** Format: uuid */
                id: string;
                locked: boolean;
                /** Format: uuid */
                planVersionId: string;
                /** Format: date-time */
                startAt: string;
                status: "planned" | "done" | "skipped" | "moved" | "superseded";
                /** Format: uuid */
                taskId: string;
                version: number;
            }[];
            /** Format: date-time */
            capturedAt: string;
            metrics: {
                minSlackMin: number;
                taskSlack: {
                    /** Format: date-time */
                    dueAt: string;
                    slackMin: number;
                    /** Format: uuid */
                    taskId: string;
                }[];
                totalFocusMin: number;
            };
        };
        ReplanBeforeMetrics: {
            minSlackMin: number;
            taskSlack: {
                /** Format: date-time */
                dueAt: string;
                slackMin: number;
                /** Format: uuid */
                taskId: string;
            }[];
            totalFocusMin: number;
        };
        ReplanCandidate: {
            blocks: {
                /** Format: date-time */
                endAt: string;
                /** Format: date-time */
                startAt: string;
                /** Format: uuid */
                taskId: string;
            }[];
            bound: number;
            changedBlocks: number;
            explanation: string[];
            explanationItems?: {
                code: "policy_summary" | "placement_summary" | "constraints_satisfied" | "infeasible_summary" | "heuristic_insufficient_available_time" | "heuristic_no_contiguous_window" | "heuristic_estimate_not_grid_aligned" | "heuristic_estimate_below_grid" | "heuristic_session_bounds_infeasible" | "unplaced_minutes" | "capacity_deficit" | "replan_bound_exceeded" | "input_rejected" | "input_invalid_time_zone" | "input_invalid_horizon_instant" | "input_horizon_not_increasing" | "input_horizon_too_long" | "input_invalid_now" | "input_duplicate_task" | "input_invalid_estimate" | "input_invalid_buffer" | "input_invalid_session_minutes" | "input_invalid_session_bounds" | "input_invalid_task_window_instant" | "input_task_window_empty" | "input_invalid_preference" | "input_unknown_dependency" | "input_dependency_cycle" | "input_invalid_weekday" | "input_invalid_availability_window" | "input_invalid_exception_date" | "input_exception_partial_window" | "input_invalid_exception_window" | "input_commitment_invalid_instant" | "input_commitment_end_before_start" | "input_commitment_too_long" | "input_unknown_block_task" | "input_invalid_block_instant" | "input_block_sub_millisecond" | "input_block_off_grid" | "input_block_end_before_start" | "input_block_too_long" | "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
                params: {
                    [key: string]: string | number;
                };
            }[];
            flags: ("infeasible" | "bound_exceeded" | "scope_extended" | "capacity_deficit")[];
            metrics: {
                avgDailyLoadMin: number;
                capacityDeficitMin: number;
                changedBlocks: number;
                contextSwitches: number;
                deficitMin: number;
                maxDailyLoadMin: number;
                minSlackMin: number;
                p90CoverageRatio: number;
                totalFocusMin: number;
            };
        };
        ReplanProposal: {
            availabilityVersion: number;
            basePlanVersion: number;
            /** Format: uuid */
            basePlanVersionId: string;
            before?: {
                blocks: {
                    /** Format: date-time */
                    endAt: string;
                    /** Format: uuid */
                    id: string;
                    locked: boolean;
                    /** Format: uuid */
                    planVersionId: string;
                    /** Format: date-time */
                    startAt: string;
                    status: "planned" | "done" | "skipped" | "moved" | "superseded";
                    /** Format: uuid */
                    taskId: string;
                    version: number;
                }[];
                /** Format: date-time */
                capturedAt: string;
                metrics: {
                    minSlackMin: number;
                    taskSlack: {
                        /** Format: date-time */
                        dueAt: string;
                        slackMin: number;
                        /** Format: uuid */
                        taskId: string;
                    }[];
                    totalFocusMin: number;
                };
            };
            candidate: {
                blocks: {
                    /** Format: date-time */
                    endAt: string;
                    /** Format: date-time */
                    startAt: string;
                    /** Format: uuid */
                    taskId: string;
                }[];
                bound: number;
                changedBlocks: number;
                explanation: string[];
                explanationItems?: {
                    code: "policy_summary" | "placement_summary" | "constraints_satisfied" | "infeasible_summary" | "heuristic_insufficient_available_time" | "heuristic_no_contiguous_window" | "heuristic_estimate_not_grid_aligned" | "heuristic_estimate_below_grid" | "heuristic_session_bounds_infeasible" | "unplaced_minutes" | "capacity_deficit" | "replan_bound_exceeded" | "input_rejected" | "input_invalid_time_zone" | "input_invalid_horizon_instant" | "input_horizon_not_increasing" | "input_horizon_too_long" | "input_invalid_now" | "input_duplicate_task" | "input_invalid_estimate" | "input_invalid_buffer" | "input_invalid_session_minutes" | "input_invalid_session_bounds" | "input_invalid_task_window_instant" | "input_task_window_empty" | "input_invalid_preference" | "input_unknown_dependency" | "input_dependency_cycle" | "input_invalid_weekday" | "input_invalid_availability_window" | "input_invalid_exception_date" | "input_exception_partial_window" | "input_invalid_exception_window" | "input_commitment_invalid_instant" | "input_commitment_end_before_start" | "input_commitment_too_long" | "input_unknown_block_task" | "input_invalid_block_instant" | "input_block_sub_millisecond" | "input_block_off_grid" | "input_block_end_before_start" | "input_block_too_long" | "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
                    params: {
                        [key: string]: string | number;
                    };
                }[];
                flags: ("infeasible" | "bound_exceeded" | "scope_extended" | "capacity_deficit")[];
                metrics: {
                    avgDailyLoadMin: number;
                    capacityDeficitMin: number;
                    changedBlocks: number;
                    contextSwitches: number;
                    deficitMin: number;
                    maxDailyLoadMin: number;
                    minSlackMin: number;
                    p90CoverageRatio: number;
                    totalFocusMin: number;
                };
            };
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            expiresAt: string;
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            planId: string;
            state: "pending" | "approved" | "rejected" | "expired" | "superseded";
            /** @description Replan trigger plus the caller-supplied affected task scope (06 §7.1). Non-affected future blocks stay fixed. */
            trigger: {
                affectedTaskIds: string[];
                /** Format: date-time */
                detectedAt: string;
                kind: "deadline_risk" | "commitment_conflict" | "early_completion" | "user_request";
                reason: "deadline_slack_negative" | "commitment_overlap" | "early_completion_capacity" | "dependency_change" | "user_request";
            };
            version: number;
        };
        ReplanProposalIdParams: {
            /** Format: uuid */
            id: string;
        };
        ReplanProposalListQuery: {
            cursor?: string;
            limit?: number;
            state?: "pending" | "approved" | "rejected" | "expired" | "superseded";
        };
        ReplanProposalPage: {
            items: {
                availabilityVersion: number;
                basePlanVersion: number;
                /** Format: uuid */
                basePlanVersionId: string;
                before?: {
                    blocks: {
                        /** Format: date-time */
                        endAt: string;
                        /** Format: uuid */
                        id: string;
                        locked: boolean;
                        /** Format: uuid */
                        planVersionId: string;
                        /** Format: date-time */
                        startAt: string;
                        status: "planned" | "done" | "skipped" | "moved" | "superseded";
                        /** Format: uuid */
                        taskId: string;
                        version: number;
                    }[];
                    /** Format: date-time */
                    capturedAt: string;
                    metrics: {
                        minSlackMin: number;
                        taskSlack: {
                            /** Format: date-time */
                            dueAt: string;
                            slackMin: number;
                            /** Format: uuid */
                            taskId: string;
                        }[];
                        totalFocusMin: number;
                    };
                };
                candidate: {
                    blocks: {
                        /** Format: date-time */
                        endAt: string;
                        /** Format: date-time */
                        startAt: string;
                        /** Format: uuid */
                        taskId: string;
                    }[];
                    bound: number;
                    changedBlocks: number;
                    explanation: string[];
                    explanationItems?: {
                        code: "policy_summary" | "placement_summary" | "constraints_satisfied" | "infeasible_summary" | "heuristic_insufficient_available_time" | "heuristic_no_contiguous_window" | "heuristic_estimate_not_grid_aligned" | "heuristic_estimate_below_grid" | "heuristic_session_bounds_infeasible" | "unplaced_minutes" | "capacity_deficit" | "replan_bound_exceeded" | "input_rejected" | "input_invalid_time_zone" | "input_invalid_horizon_instant" | "input_horizon_not_increasing" | "input_horizon_too_long" | "input_invalid_now" | "input_duplicate_task" | "input_invalid_estimate" | "input_invalid_buffer" | "input_invalid_session_minutes" | "input_invalid_session_bounds" | "input_invalid_task_window_instant" | "input_task_window_empty" | "input_invalid_preference" | "input_unknown_dependency" | "input_dependency_cycle" | "input_invalid_weekday" | "input_invalid_availability_window" | "input_invalid_exception_date" | "input_exception_partial_window" | "input_invalid_exception_window" | "input_commitment_invalid_instant" | "input_commitment_end_before_start" | "input_commitment_too_long" | "input_unknown_block_task" | "input_invalid_block_instant" | "input_block_sub_millisecond" | "input_block_off_grid" | "input_block_end_before_start" | "input_block_too_long" | "h0_unknown_task" | "h0_outside_horizon" | "h1_same_task_overlap" | "h1_tasks_overlap" | "h1_commitment_overlap" | "h1_active_block_overlap" | "h2_outside_availability" | "h3_dependency_order" | "h4_before_earliest_start" | "h4_inside_due_buffer" | "h4_after_due" | "h5_unsplittable_no_remaining" | "h5_unsplittable_required_out_of_bounds" | "h5_unsplittable_single_block" | "h5_session_out_of_bounds" | "h6_daily_focus_exceeded" | "h6_break_missing" | "h7_deficit" | "h7_overallocated" | "h8_invalid_time_zone" | "h8_invalid_horizon" | "h8_invalid_instant" | "h8_sub_millisecond" | "h8_off_grid" | "h8_end_before_start";
                        params: {
                            [key: string]: string | number;
                        };
                    }[];
                    flags: ("infeasible" | "bound_exceeded" | "scope_extended" | "capacity_deficit")[];
                    metrics: {
                        avgDailyLoadMin: number;
                        capacityDeficitMin: number;
                        changedBlocks: number;
                        contextSwitches: number;
                        deficitMin: number;
                        maxDailyLoadMin: number;
                        minSlackMin: number;
                        p90CoverageRatio: number;
                        totalFocusMin: number;
                    };
                };
                /** Format: date-time */
                createdAt: string;
                /** Format: date-time */
                expiresAt: string;
                /** Format: uuid */
                id: string;
                /** Format: uuid */
                planId: string;
                state: "pending" | "approved" | "rejected" | "expired" | "superseded";
                /** @description Replan trigger plus the caller-supplied affected task scope (06 §7.1). Non-affected future blocks stay fixed. */
                trigger: {
                    affectedTaskIds: string[];
                    /** Format: date-time */
                    detectedAt: string;
                    kind: "deadline_risk" | "commitment_conflict" | "early_completion" | "user_request";
                    reason: "deadline_slack_negative" | "commitment_overlap" | "early_completion_capacity" | "dependency_change" | "user_request";
                };
                version: number;
            }[];
            nextCursor: string | null;
        };
        ReplanReject: {
            reason?: string;
        };
        ReplanRequest: {
            affectedTaskIds?: string[];
            /** Format: uuid */
            planId: string;
            reason?: "deadline_slack_negative" | "commitment_overlap" | "early_completion_capacity" | "dependency_change" | "user_request";
        };
        ReplanTaskSlack: {
            /** Format: date-time */
            dueAt: string;
            slackMin: number;
            /** Format: uuid */
            taskId: string;
        };
        /** @description Replan trigger plus the caller-supplied affected task scope (06 §7.1). Non-affected future blocks stay fixed. */
        ReplanTrigger: {
            affectedTaskIds: string[];
            /** Format: date-time */
            detectedAt: string;
            kind: "deadline_risk" | "commitment_conflict" | "early_completion" | "user_request";
            reason: "deadline_slack_negative" | "commitment_overlap" | "early_completion_capacity" | "dependency_change" | "user_request";
        };
        ScheduleBlock: {
            /** Format: date-time */
            endAt: string;
            /** Format: uuid */
            id: string;
            locked: boolean;
            /** Format: uuid */
            planVersionId: string;
            /** Format: date-time */
            startAt: string;
            status: "planned" | "done" | "skipped" | "moved" | "superseded";
            /** Format: uuid */
            taskId: string;
            version: number;
        };
        ScheduleBlockIdParams: {
            /** Format: uuid */
            id: string;
        };
        ScheduleBlockListQuery: {
            cursor?: string;
            /** Format: date-time */
            from: string;
            limit?: number;
            /** Format: date-time */
            to: string;
        };
        ScheduleBlockPage: {
            items: {
                /** Format: date-time */
                endAt: string;
                /** Format: uuid */
                id: string;
                locked: boolean;
                /** Format: uuid */
                planVersionId: string;
                /** Format: date-time */
                startAt: string;
                status: "planned" | "done" | "skipped" | "moved" | "superseded";
                /** Format: uuid */
                taskId: string;
                version: number;
            }[];
            nextCursor: string | null;
        };
        /** @description Starts a focus session. clientStartedAt is clamped to [serverNow - 24 h, serverNow + 2 min]; the clamp is recorded so offline replay is exactly-once but observable. */
        SessionCreate: {
            /** Format: uuid */
            blockId?: string;
            clientId: string;
            /**
             * Format: date-time
             * @description Device clock at session start. The server accepts it within [serverNow - 24 h, serverNow + 2 min] and clamps values outside that window, recording the clamp.
             */
            clientStartedAt: string;
            /** Format: uuid */
            taskId: string;
        };
        /** @description Session event with its client timestamp. Clamping rules are [session.startedAt, serverNow + 2 min] plus per-session monotonicity; clamped values are recorded. */
        SessionEventRequest: {
            /**
             * Format: date-time
             * @description Device clock at the event. Accepted within [session.startedAt, serverNow + 2 min] and monotonic per session; out-of-range or out-of-order values are clamped to the nearest bound and the clamp is recorded.
             */
            clientAt: string;
        };
        SessionIdParams: {
            /** Format: uuid */
            id: string;
        };
        SessionListQuery: {
            cursor?: string;
            limit?: number;
            state?: "active" | "paused" | "completed" | "abandoned";
        };
        SessionReviewRequest: {
            note?: string;
            outcome: "done" | "partial" | "blocked";
            reasonChips: ("focus_lost" | "interrupted" | "task_larger" | "task_smaller" | "blocked_dependency" | "low_energy" | "other")[];
        };
        Task: {
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            deletedAt?: string;
            dependsOn: string[];
            description?: string;
            /** Format: date-time */
            dueAt?: string;
            external: {
                externalId: string;
                /** @constant */
                provider: "vikunja";
            }[];
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            ownerId: string;
            priority: number;
            /** Format: uuid */
            projectId: string;
            session?: {
                maxMinutes: number;
                minMinutes: number;
            };
            splittable: boolean;
            status: "todo" | "in_progress" | "done";
            title: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        TaskCreate: {
            dependsOn?: string[];
            description?: string;
            /** Format: date-time */
            dueAt?: string;
            priority?: number;
            /** Format: uuid */
            projectId?: string;
            session?: {
                maxMinutes: number;
                minMinutes: number;
            };
            splittable?: boolean;
            status?: "todo" | "in_progress" | "done";
            title: string;
        };
        TaskDependency: {
            /** Format: uuid */
            dependsOnTaskId: string;
            /** Format: uuid */
            taskId: string;
        };
        TaskDependencyCreate: {
            /** Format: uuid */
            dependsOnTaskId: string;
        };
        TaskIdParams: {
            /** Format: uuid */
            id: string;
        };
        TaskListQuery: {
            cursor?: string;
            limit?: number;
            /** Format: uuid */
            projectId?: string;
            status?: "todo" | "in_progress" | "done";
        };
        TaskPatch: {
            dependsOn?: string[];
            description?: string | null;
            dueAt?: string | null;
            priority?: number;
            /** Format: uuid */
            projectId?: string;
            session?: {
                maxMinutes: number;
                minMinutes: number;
            } | null;
            splittable?: boolean;
            status?: "todo" | "in_progress" | "done";
            title?: string;
        };
        TaskTemplate: {
            confidence: number;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            deletedAt?: string;
            /** Format: uuid */
            id: string;
            name: string;
            /** Format: uuid */
            ownerId: string;
            source: "user" | "system";
            stats: {
                meanRatio?: number;
                p90Ratio?: number;
                sampleCount?: number;
            };
            steps: {
                deliverable: string;
                dependsOn: string[];
                doneCriteria: string;
                estimate: {
                    p50Minutes: number;
                    p90Minutes: number;
                };
                key: string;
                kind: "prep" | "work" | "review" | "buffer";
                splittable: boolean;
                title: string;
            }[];
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        TaskTemplateIdParams: {
            /** Format: uuid */
            id: string;
        };
        TaskTemplateListQuery: {
            cursor?: string;
            limit?: number;
            query?: string;
        };
        TemplateStats: {
            meanRatio?: number;
            p90Ratio?: number;
            sampleCount?: number;
        };
        Today: {
            blocks: {
                /** Format: date-time */
                endAt: string;
                /** Format: uuid */
                id: string;
                /** Format: date-time */
                startAt: string;
                status: "planned" | "done" | "skipped" | "moved" | "superseded";
                /** Format: uuid */
                taskId: string;
                title: string;
            }[];
            /** Format: date */
            date: string;
            risk: {
                level: "low" | "medium" | "high";
                reasons: string[];
            };
            slackMin: number;
            /** Format: iana-time-zone */
            timeZone: string;
            version: number;
        };
        TodayAcceptRequest: {
            blockIds?: string[];
            /** Format: date */
            date: string;
        };
        TodayBlock: {
            /** Format: date-time */
            endAt: string;
            /** Format: uuid */
            id: string;
            /** Format: date-time */
            startAt: string;
            status: "planned" | "done" | "skipped" | "moved" | "superseded";
            /** Format: uuid */
            taskId: string;
            title: string;
        };
        /** @description Persisted shrink/reschedule proposal with its base plan version and availability snapshot. Approval re-validates availability atomically (08 §2.4). */
        TodayProposal: {
            availabilityVersion: number;
            /** Format: uuid */
            basePlanVersionId: string;
            blocks: {
                /** Format: uuid */
                blockId: string;
                /** Format: date-time */
                endAt: string;
                /** Format: date-time */
                startAt: string;
                /** Format: uuid */
                taskId: string;
            }[];
            /** Format: date-time */
            createdAt: string;
            /** Format: date */
            date: string;
            /** Format: date-time */
            expiresAt?: string;
            /** Format: uuid */
            id: string;
            kind: "shrink" | "reschedule";
            /** Format: iana-time-zone */
            timeZone: string;
            version: number;
        };
        TodayProposalBlock: {
            /** Format: uuid */
            blockId: string;
            /** Format: date-time */
            endAt: string;
            /** Format: date-time */
            startAt: string;
            /** Format: uuid */
            taskId: string;
        };
        TodayProposalParams: {
            /** Format: uuid */
            id: string;
        };
        TodayQuery: {
            /** Format: date */
            date: string;
        };
        TodayRescheduleRequest: {
            blockIds: string[];
            /** Format: date */
            date: string;
            /** Format: date */
            toDate?: string;
        };
        TodayRisk: {
            level: "low" | "medium" | "high";
            reasons: string[];
        };
        TodayShrinkRequest: {
            /** Format: uuid */
            blockId: string;
            /** Format: date */
            date: string;
            targetMin: number;
        };
        User: {
            /** Format: date-time */
            createdAt: string;
            /** Format: email */
            email: string;
            /** Format: uuid */
            id: string;
            llm?: {
                budget?: {
                    dailyUsd: number;
                    monthlyUsd: number;
                };
                consent?: {
                    /** Format: date-time */
                    at: string;
                    granted: boolean;
                    provider: string;
                };
            };
            llmProvider?: "fake" | "deepseek";
            locale: string;
            /** Format: iana-time-zone */
            timeZone: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        UserSettingsPatch: {
            llm?: {
                budget?: {
                    dailyUsd?: number;
                    monthlyUsd?: number;
                };
                consent?: {
                    granted: boolean;
                };
            };
            locale?: string;
            /** Format: iana-time-zone */
            timeZone?: string;
        };
        WorkSession: {
            /** Format: uuid */
            blockId?: string;
            clientId: string;
            /** Format: date-time */
            endedAt?: string;
            focusedSec: number;
            /** Format: uuid */
            id: string;
            pausedSec: number;
            /** Format: date-time */
            startedAt: string;
            state: "active" | "paused" | "completed" | "abandoned";
            /** Format: uuid */
            taskId: string;
            version: number;
        };
        WorkSessionPage: {
            items: {
                /** Format: uuid */
                blockId?: string;
                clientId: string;
                /** Format: date-time */
                endedAt?: string;
                focusedSec: number;
                /** Format: uuid */
                id: string;
                pausedSec: number;
                /** Format: date-time */
                startedAt: string;
                state: "active" | "paused" | "completed" | "abandoned";
                /** Format: uuid */
                taskId: string;
                version: number;
            }[];
            nextCursor: string | null;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Session created */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Rate limited */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    logout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session destroyed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getAvailability: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Availability */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Availability"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    putAvailability: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AvailabilityPut"];
            };
        };
        responses: {
            /** @description Updated availability */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Availability"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listCommitments: {
        parameters: {
            query: {
                from: string;
                to: string;
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Commitment page with expanded occurrences */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CommitmentPage"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createCommitment: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CommitmentCreate"];
            };
        };
        responses: {
            /** @description Created commitment */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Commitment"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteCommitment: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Commitment deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateCommitment: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CommitmentPatch"];
            };
        };
        responses: {
            /** @description Updated commitment */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Commitment"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listDocuments: {
        parameters: {
            query?: {
                q?: string;
                targetKind?: "goal" | "project" | "task";
                targetId?: string;
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Note page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContextDocumentPage"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createDocument: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContextDocumentCreate"];
            };
        };
        responses: {
            /** @description Created note */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContextDocument"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getDocument: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Note */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContextDocument"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteDocument: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Note deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateDocument: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContextDocumentPatch"];
            };
        };
        responses: {
            /** @description Updated note */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContextDocument"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listDocumentAiUsage: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description AI usage page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NoteAiUsagePage"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    addDocumentLink: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DocumentLinkCreate"];
            };
        };
        responses: {
            /** @description Note with the new link */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContextDocument"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    removeDocumentLink: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
                linkId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Note without the link */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContextDocument"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    patchEstimationFeedback: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EstimationFeedbackPatch"];
            };
        };
        responses: {
            /** @description Updated feedback item */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EstimationProfileItem"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getEstimationProfile: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Estimation profile */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EstimationProfile"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    resetEstimation: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EstimationReset"];
            };
        };
        responses: {
            /** @description Refreshed estimation profile */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EstimationProfile"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createExport: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Export queued */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExportStartResponse"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getExport: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Export job */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Export"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createIntakeSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IntakeSessionCreate"];
            };
        };
        responses: {
            /** @description Intake session created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getIntakeSession: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Intake session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    answerIntakeQuestions: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IntakeAnswersRequest"];
            };
        };
        responses: {
            /** @description Updated intake session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getIntakeDraft: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Decomposition draft */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecompositionDraft"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateIntakeDraft: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DecompositionDraftPatch"];
            };
        };
        responses: {
            /** @description Updated decomposition draft */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DecompositionDraft"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    approveIntakeDraft: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Intake session advanced to feasibility check */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    confirmIntakeType: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["IntakeTypeConfirmation"];
            };
        };
        responses: {
            /** @description Updated intake session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    cancelIntakeSession: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cancelled intake session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    enterManualIntakeMode: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Manual-mode intake session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    pauseIntakeSession: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paused intake session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    resumeIntakeSession: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resumed intake session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IntakeSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current user */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateMySettings: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserSettingsPatch"];
            };
        };
        responses: {
            /** @description Updated user */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listNotifications: {
        parameters: {
            query?: {
                state?: "scheduled" | "sent" | "dismissed" | "failed" | "expired";
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Notification page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationPage"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    dismissNotification: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dismissed notification */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Notification"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createPlan: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlanCreate"];
            };
        };
        responses: {
            /** @description Plan with up to three candidates */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plan"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getPlan: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Plan */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plan"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    approvePlanCandidate: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
                cid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ApprovePlanRequest"];
            };
        };
        responses: {
            /** @description Approved plan version */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanVersion"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    previewPlanCandidateEdit: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
                cid: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PreviewEditRequest"];
            };
        };
        responses: {
            /** @description Validator result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PreviewEditResponse"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    regeneratePlan: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Regenerated plan */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Plan"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listProjects: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Project page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageProject"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createProject: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectCreate"];
            };
        };
        responses: {
            /** @description Created project */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Project"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createPushSubscription: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PushSubscriptionCreate"];
            };
        };
        responses: {
            /** @description Created push subscription */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PushSubscription"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deletePushSubscription: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Push subscription removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listReplanProposals: {
        parameters: {
            query?: {
                state?: "pending" | "approved" | "rejected" | "expired" | "superseded";
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Replan proposal page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplanProposalPage"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getReplanProposal: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Replan proposal */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplanProposal"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    approveReplanProposal: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReplanApproveRequest"];
            };
        };
        responses: {
            /** @description Approved plan version */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanVersion"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    rejectReplanProposal: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReplanReject"];
            };
        };
        responses: {
            /** @description Rejected replan proposal */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplanProposal"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    requestReplanProposal: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReplanRequest"];
            };
        };
        responses: {
            /** @description Created replan proposal */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReplanProposal"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listScheduleBlocks: {
        parameters: {
            query: {
                from: string;
                to: string;
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Schedule block page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScheduleBlockPage"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    lockScheduleBlock: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Locked schedule block */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScheduleBlock"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    unlockScheduleBlock: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Unlocked schedule block */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScheduleBlock"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listSessions: {
        parameters: {
            query?: {
                state?: "active" | "paused" | "completed" | "abandoned";
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Work session page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkSessionPage"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createSession: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionCreate"];
            };
        };
        responses: {
            /** @description Started session */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Work session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkSession"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    reviewSession: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionReviewRequest"];
            };
        };
        responses: {
            /** @description Estimation feedback */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EstimationFeedback"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    completeSession: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionEventRequest"];
            };
        };
        responses: {
            /** @description Completed session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    pauseSession: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionEventRequest"];
            };
        };
        responses: {
            /** @description Paused session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    resumeSession: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SessionEventRequest"];
            };
        };
        responses: {
            /** @description Resumed session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkSession"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listTasks: {
        parameters: {
            query?: {
                projectId?: string;
                status?: "todo" | "in_progress" | "done";
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageTask"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createTask: {
        parameters: {
            query?: never;
            header: {
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskCreate"];
            };
        };
        responses: {
            /** @description Created task */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getTask: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    deleteTask: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    updateTask: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskPatch"];
            };
        };
        responses: {
            /** @description Updated task */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    createTaskDependency: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TaskDependencyCreate"];
            };
        };
        responses: {
            /** @description Created dependency */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskDependency"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    completeTask: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Completed task */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Task"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    promoteTaskDescription: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Created note */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ContextDocument"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Provider unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    listTaskTemplates: {
        parameters: {
            query?: {
                query?: string;
                cursor?: string;
                limit?: number;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task template page */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PageTaskTemplate"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getTaskTemplate: {
        parameters: {
            query?: never;
            header?: {
                "If-None-Match"?: string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task template */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TaskTemplate"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getToday: {
        parameters: {
            query: {
                date: string;
            };
            header?: {
                "If-None-Match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Today view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Today"];
                };
            };
            /** @description Not modified */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    approveTodayProposal: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Approved plan version */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlanVersion"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    acceptToday: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TodayAcceptRequest"];
            };
        };
        responses: {
            /** @description Accepted today view */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Today"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    rescheduleToday: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TodayRescheduleRequest"];
            };
        };
        responses: {
            /** @description Reschedule proposal */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TodayProposal"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    shrinkToday: {
        parameters: {
            query?: never;
            header: {
                "If-Match": string;
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TodayShrinkRequest"];
            };
        };
        responses: {
            /** @description Shrink proposal */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TodayProposal"];
                };
            };
            /** @description Malformed request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Unauthenticated */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description State conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Version precondition failed */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description Domain validation failed */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            /** @description If-Match header required */
            428: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
}
