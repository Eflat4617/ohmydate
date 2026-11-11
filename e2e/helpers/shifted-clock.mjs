// E2E-only preload: shifts the wall clock of the process it is imported into.
//
// global-setup passes it to the planner API with NODE_OPTIONS=--import=... only
// when E2E_FAKE_NOW is set. `Date.now()` and `new Date()` then report real time
// plus E2E_CLOCK_OFFSET_MS, so time keeps flowing from the simulated start.
// Timers, `performance.now()` and explicit `new Date(value)` are untouched.
// Product code is not modified; without the variable this module is inert.

const offsetMs = Number(process.env.E2E_CLOCK_OFFSET_MS ?? '0');

if (Number.isFinite(offsetMs) && offsetMs !== 0) {
  const RealDate = globalThis.Date;
  const realNow = RealDate.now.bind(RealDate);

  function ShiftedDate(...args) {
    if (new.target === undefined) {
      return new RealDate(realNow() + offsetMs).toString();
    }
    return Reflect.construct(
      RealDate,
      args.length === 0 ? [realNow() + offsetMs] : args,
      new.target,
    );
  }

  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = () => realNow() + offsetMs;
  globalThis.Date = ShiftedDate;
}
