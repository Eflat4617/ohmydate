import { OWNER_SWITCH_SHARDS, sweepShard } from './support/ownerSwitchCases';

// FU-77 owner-isolation sweep, slice 3 (see owner-switch-sweep.spec.ts).
sweepShard(3, OWNER_SWITCH_SHARDS);
