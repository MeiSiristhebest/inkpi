// Global test setup.
//
// Originally this file was intentionally empty of provider state: the `faux`
// provider and `mock-test` preset used to be silently registered on the
// *production* path (a P0 correctness bug). They now live behind an explicit
// `installTestDoubles()` fixture so that:
//   1. Production code never silently falls back to a fake model.
//   2. Tests opt into the doubles on purpose, here, once.
import { installTestDoubles } from '@inkpi/ai';

// Idempotent: safe to call from multiple setup files / repeatedly.
installTestDoubles();
