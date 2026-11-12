import { OWNER_SWITCH_SHARDS, sweepShard } from './support/ownerSwitchCases';

// FU-77 owner-isolation sweep, slice 2 (see owner-switch-sweep.spec.ts).
sweepShard(2, OWNER_SWITCH_SHARDS);
