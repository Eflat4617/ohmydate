//! Published generator policies: a port of
//! `packages/scheduler/src/policies.ts` (06 §4).
//!
//! `POLICY_VERSION` covers the weights, the task ordering and the
//! slot-selection rule together; it is part of every candidate's explanation
//! so stored plans trace to one versioned contract. Changing any of the
//! three requires a new version.

use crate::types::PolicyName;

pub const POLICY_VERSION: &str = "1.0.0";

/// Objective weights S1–S6 of the bounded local improvement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PolicyWeights {
    pub s1_early_completion: f64,
    pub s2_daily_spread: f64,
    pub s3_preferred_windows: f64,
    pub s4_context_switches: f64,
    pub s5_retain_existing: f64,
    pub s6_min_slack: f64,
}

/// The order in which the greedy pass takes ready tasks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyOrdering {
    /// Earliest due date first.
    Edf,
    PriorityThenLength,
    LongestFirst,
}

/// How the greedy pass picks a position for a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicySlotRule {
    ChronologicalEarliest,
    LeastLoadedDay,
    LongestSlotThenFewestSwitches,
}

impl PolicySlotRule {
    /// The reference's spelling.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ChronologicalEarliest => "chronological-earliest",
            Self::LeastLoadedDay => "least-loaded-day",
            Self::LongestSlotThenFewestSwitches => "longest-slot-then-fewest-switches",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PolicyProfile {
    pub name: PolicyName,
    pub version: &'static str,
    pub weights: PolicyWeights,
    pub ordering: PolicyOrdering,
    pub slot_rule: PolicySlotRule,
    pub summary: &'static str,
}

const FRONT_LOADED: PolicyProfile = PolicyProfile {
    name: PolicyName::FrontLoaded,
    version: POLICY_VERSION,
    weights: PolicyWeights {
        s1_early_completion: 1.0,
        s2_daily_spread: 0.1,
        s3_preferred_windows: 0.2,
        s4_context_switches: 0.3,
        s5_retain_existing: 0.5,
        s6_min_slack: 0.6,
    },
    ordering: PolicyOrdering::Edf,
    slot_rule: PolicySlotRule::ChronologicalEarliest,
    summary: "Finish work as early as possible and maximise due-date slack.",
};

const BALANCED: PolicyProfile = PolicyProfile {
    name: PolicyName::Balanced,
    version: POLICY_VERSION,
    weights: PolicyWeights {
        s1_early_completion: 0.2,
        s2_daily_spread: 1.0,
        s3_preferred_windows: 0.3,
        s4_context_switches: 0.3,
        s5_retain_existing: 0.5,
        s6_min_slack: 0.4,
    },
    ordering: PolicyOrdering::PriorityThenLength,
    slot_rule: PolicySlotRule::LeastLoadedDay,
    summary: "Spread work evenly across days.",
};

const FOCUS_BLOCKED: PolicyProfile = PolicyProfile {
    name: PolicyName::FocusBlocked,
    version: POLICY_VERSION,
    weights: PolicyWeights {
        s1_early_completion: 0.3,
        s2_daily_spread: 0.3,
        s3_preferred_windows: 0.8,
        s4_context_switches: 1.0,
        s5_retain_existing: 0.5,
        s6_min_slack: 0.4,
    },
    ordering: PolicyOrdering::LongestFirst,
    slot_rule: PolicySlotRule::LongestSlotThenFewestSwitches,
    summary: "Prefer long contiguous focus blocks and few context switches.",
};

/// The profile of a policy.
#[must_use]
pub const fn profile(policy: PolicyName) -> &'static PolicyProfile {
    match policy {
        PolicyName::FrontLoaded => &FRONT_LOADED,
        PolicyName::Balanced => &BALANCED,
        PolicyName::FocusBlocked => &FOCUS_BLOCKED,
    }
}

/// The seed offset that gives each policy its own random stream.
#[must_use]
pub const fn seed_offset(policy: PolicyName) -> f64 {
    match policy {
        PolicyName::FrontLoaded => 0.0,
        PolicyName::Balanced => 7919.0,
        PolicyName::FocusBlocked => 15486.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_policy_has_its_own_profile_at_the_published_version() {
        for policy in PolicyName::ALL {
            let profile = profile(*policy);
            assert_eq!(profile.name, *policy);
            assert_eq!(profile.version, POLICY_VERSION);
            assert!(!profile.summary.is_empty());
        }
        assert_eq!(
            profile(PolicyName::FrontLoaded).ordering,
            PolicyOrdering::Edf
        );
        assert_eq!(
            profile(PolicyName::Balanced).slot_rule.as_str(),
            "least-loaded-day"
        );
        assert_eq!(
            profile(PolicyName::FocusBlocked).ordering,
            PolicyOrdering::LongestFirst
        );
        assert_ne!(
            profile(PolicyName::FrontLoaded).weights,
            profile(PolicyName::Balanced).weights
        );
    }

    #[test]
    fn the_published_weights_are_the_contract() {
        let weights = |policy| {
            let w = profile(policy).weights;
            [
                w.s1_early_completion,
                w.s2_daily_spread,
                w.s3_preferred_windows,
                w.s4_context_switches,
                w.s5_retain_existing,
                w.s6_min_slack,
            ]
        };
        assert_eq!(
            weights(PolicyName::FrontLoaded),
            [1.0, 0.1, 0.2, 0.3, 0.5, 0.6]
        );
        assert_eq!(
            weights(PolicyName::Balanced),
            [0.2, 1.0, 0.3, 0.3, 0.5, 0.4]
        );
        assert_eq!(
            weights(PolicyName::FocusBlocked),
            [0.3, 0.3, 0.8, 1.0, 0.5, 0.4]
        );
        assert_eq!(
            PolicyName::ALL
                .iter()
                .map(|policy| seed_offset(*policy))
                .collect::<Vec<_>>(),
            [0.0, 7919.0, 15486.0]
        );
    }
}
