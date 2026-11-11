import {
  acquireDistLease,
  ensureApiDist,
  releaseDistLease,
} from './dist-artifact.js';

export default async function setup(): Promise<void> {
  await acquireDistLease();
  try {
    await ensureApiDist();
  } finally {
    await releaseDistLease();
  }
}
