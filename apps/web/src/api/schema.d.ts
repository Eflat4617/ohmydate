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
         * @description Pre-flight validation maps edited blocks outside the persisted plan horizon or outside the plan task scope to 422 validation_failed with errors[{path: "/editedBlocks/<i>", message}] before H1-H8 validation. Validator findings use 422 constraint_violation with violations[].
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
        DecompositionDraft: {
            assumptions: string[];
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
        LoginRequest: {
            /** Format: email */
            email: string;
            password: string;
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
                explanation: string[];
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
            explanation: string[];
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
                /** Format: uuid */
                taskId?: string;
            }[];
        };
        Problem: {
            code: "validation_failed" | "version_conflict" | "availability_changed" | "constraint_violation" | "idempotency_mismatch" | "provider_unavailable" | "llm_unavailable" | "budget_exceeded" | "dependency_cycle" | "illegal_transition" | "approval_in_progress" | "not_found" | "forbidden" | "rate_limited" | "unauthenticated" | "idempotency_in_progress" | "internal_error";
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
        User: {
            /** Format: date-time */
            createdAt: string;
            /** Format: email */
            email: string;
            /** Format: uuid */
            id: string;
            locale: string;
            /** Format: iana-time-zone */
            timeZone: string;
            /** Format: date-time */
            updatedAt: string;
            version: number;
        };
        UserSettingsPatch: {
            locale?: string;
            /** Format: iana-time-zone */
            timeZone?: string;
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
}
