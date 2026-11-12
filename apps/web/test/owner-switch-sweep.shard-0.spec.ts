import { OWNER_SWITCH_SHARDS, sweepShard } from './support/ownerSwitchCases';

// FU-77 owner-isolation sweep, slice 0 (see owner-switch-sweep.spec.ts).
sweepShard(0, OWNER_SWITCH_SHARDS);
