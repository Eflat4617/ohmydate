import { OWNER_SWITCH_SHARDS, sweepShard } from './support/ownerSwitchCases';

// FU-77 owner-isolation sweep, slice 1 (see owner-switch-sweep.spec.ts).
sweepShard(1, OWNER_SWITCH_SHARDS);
