**English** | [Русский](./README.ru.md)

# yieldpoint-cooperative-scheduler

Cooperative multitasking in TypeScript, from scratch. Generator tasks mark their own yield points; a swappable round-robin scheduler decides when to actually pause them, on one time budget shared across all tasks. Each result is a promise you can also iterate or subscribe to.

Zero dependencies, about 600 lines, five runnable demos. Built to be read rather than installed: this is the machinery behind React's scheduler and `scheduler.yield()`, written small enough to fit in your head.

---

## Contents

- [The problem](#the-problem)
- [The idea](#the-idea)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Files](#files)
- [API](#api)
- [Tuning quota and delay](#tuning-quota-and-delay)
- [How it works](#how-it-works)
- [Demos](#demos)
- [Known limitations](#known-limitations)
- [When to use this, and when not to](#when-to-use-this-and-when-not-to)
- [License](#license)

---

## The problem

JavaScript runs your code on one thread. While a synchronous function is running, the engine cannot do anything else: no frame is painted, no click is handled, no socket is accepted, no timer callback fires. The event loop turns between tasks, never inside one.

```js
function bigArray(n) {
  const array = [];
  for (let i = 0; i < n; i++) array.push(i);
  return array;
}

for (let i = 0; i < 20; i++) {
  console.log(bigArray(1_000_000).length);
}
```

Run `node demo-problem.ts` and watch the heartbeat timer. It is set to fire every 10 ms and reports the real gap between ticks:

```
heartbeat +10ms
heartbeat +10ms
--- computing ---
chunk: 1000000
...
heartbeat +2841ms
```

Nearly three seconds of silence. In a browser that is 170 dropped frames. On a server it is 170 requests sitting in the accept queue.

The effect compounds. A single 30 ms handler is invisible; a hundred of them arriving together queue up, and the last request waits three seconds to be served in 30 ms. Tail latency collapses long before the average moves, which is why average-based dashboards miss it.

**What we are actually fixing:** not the total amount of computation, but the length of the longest uninterrupted block. The work does not get smaller. It gets chopped up.

## The idea

Cooperative multitasking means a task decides for itself when to step aside. Nothing can force it. This is the opposite of the preemptive model your OS uses, where the scheduler takes the CPU away by timer interrupt whether the task likes it or not.

The model is old (Windows 3.x, Mac OS 9) and was abandoned at the OS level for a good reason: one misbehaving program froze the machine. But it came back inside processes, because within a single process it is cheap and race-free. Every `await` in JavaScript is a cooperative yield point. So are Go's goroutines, Kotlin's coroutines, and React Fiber's work loop.

Generators give us the mechanism. A generator remembers where it stopped and what its local variables held, so an ordinary loop can be paused and resumed without being turned inside out into a state machine:

```ts
function* work(t: TaskHelper, n: number) {
  let data: number[] = [];

  for (let i = 0; i < n; i++) {
    data.push(i);

    if (t.shouldPause()) {
      yield data;   // suspend here
      data = [];    // resume here
    }
  }

  return "done";
}
```

**The part that trips everyone up:** `yield` on its own does not release the thread. It hands control back to whoever called `.next()`, synchronously, in the same tick. Drive a generator with a `while` loop and you have blocked the thread exactly as before, plus overhead.

Control reaches the event loop only because the runner schedules the next `.next()` as a macrotask. So the responsibilities split cleanly:

| Who | Decides |
|---|---|
| The generator | Where it *can* be interrupted |
| The scheduler | Where it *will* be interrupted, and for how long |

That split is the whole library.

## Requirements

- **Node >= 23.6** — runs `.ts` files directly. On Node 22.6–23.5 add `--experimental-strip-types`.
- **TypeScript >= 5.8** for `npm run typecheck` (`erasableSyntaxOnly`; the code itself needs 5.6 for three-parameter `IterableIterator`).
- `Promise.withResolvers` (ES2024).

No runtime dependencies.

## Quick start

```bash
git clone https://github.com/<you>/yieldpoint-cooperative-scheduler
cd yieldpoint-cooperative-scheduler
npm install          # only devDependencies: typescript, @types/node

npm run demo:problem      # what a frozen thread looks like
npm run demo:cooperative  # the same work, chopped up
npm run demo:parallel     # two tasks sharing one budget
npm run demo:cancel       # scheduler.clear()
npm run demo:error        # a generator that throws
```

`index.ts` is a barrel and executes nothing. Run a demo file.

## Usage

```ts
import { RoundRobinScheduler } from "./scheduler.ts";
import { taskBuilder, SimpleTaskHelper } from "./task.ts";

const scheduler = new RoundRobinScheduler({ quota: 8, delay: 4 });
const task = taskBuilder(scheduler)(SimpleTaskHelper);

const exec = task(function* doSomething(t, n: number) {
  let data: number[] = [];

  for (let i = 0; i < n; i++) {
    data.push(i);

    if (t.shouldPause()) {
      yield data;
      data = [];
    }
  }

  if (data.length > 0) yield data;

  return "done";
});

const run = exec(2_000_000);
```

Construction is curried in three stages so you configure once and call many times:

```
taskBuilder(scheduler)   // 1. which scheduler   ─┐ once per app
           (Helper)      // 2. which helper      ─┘
           (generator)   // 3. which function    ─── once per task
```

The first argument of your generator is always the helper, supplied by the library. Your own arguments start from the second, and the returned function takes only those.

### Three ways to read a result

`exec()` returns one object that satisfies three interfaces at once. Use whichever fits.

```ts
const run = exec(2_000_000);

run.on("data", (r) => {
  if (!r.done) console.log("chunk", r.value.length);
});

for await (const chunk of run) {
  console.log("chunk", chunk.length);
}

const result = await run; // "done"
```

Events fire synchronously inside the busy block. Async iteration wakes up on microtasks, after the synchronous block ends. So in the output you will see a batch of `on(data)` lines followed by the same batch of `for await` lines. That ordering is correct, not a bug.

The chain survives `.then`, `.catch` and `.finally`, so this works:

```ts
for await (const chunk of exec(n).catch(console.error)) { ... }
```

## Files

Flat layout, no directories. Read them in this order.

| File | Lines | What it is |
|---|---|---|
| [`event-emitter.ts`](./event-emitter.ts) | ~130 | Component 1 of 3. Events and async iteration |
| [`scheduler.ts`](./scheduler.ts) | ~180 | Component 2 of 3. The round-robin work loop |
| [`task.ts`](./task.ts) | ~170 | Component 3 of 3. Ties it all together |
| [`index.ts`](./index.ts) | 3 | Barrel re-export. Executes nothing |
| [`demo-problem.ts`](./demo-problem.ts) | ~40 | The problem, with no library involved |
| [`demo-cooperative.ts`](./demo-cooperative.ts) | ~60 | The fix, and all three result interfaces |
| [`demo-parallel.ts`](./demo-parallel.ts) | ~55 | Two tasks sharing one budget |
| [`demo-cancel.ts`](./demo-cancel.ts) | ~55 | `scheduler.clear()` and generator cleanup |
| [`demo-error.ts`](./demo-error.ts) | ~50 | A throwing generator, both error paths |

### `event-emitter.ts`

Dispatches two events, `data` and `error`, and doubles as an async iterable. Both interfaces live on the same object simultaneously.

The interesting part is the buffer. The scheduler runs several steps of a task inside one synchronous block and calls `emit()` several times, but an async-iteration consumer only wakes up on a microtask, which is after the block ends. A naive implementation that subscribes lazily inside `next()` therefore drops every chunk except the first. The emitter keeps a buffer of unread values and a FIFO queue of waiting resolvers, so nothing is lost and two concurrent `next()` calls receive different values.

Exports `EventEmitter`, `TEvent`, `TDataResult`, `TErrorResult`, `TDataHandler`, `TErrorHandler`.

### `scheduler.ts`

Decides which task runs now, how long the thread may be held in total, and when to sleep. The algorithm is round robin: every task gets one step and goes to the back of the queue.

The scheduler is a strategy. Implement `IScheduler` yourself — a priority queue, something like React's lanes — and pass it to `taskBuilder` without touching anything else.

The interface is called `IScheduler` rather than `Scheduler` because the DOM lib already defines a global `Scheduler` (the Prioritized Task Scheduling API). Name yours the same and TypeScript starts demanding you implement someone else's `postTask` and `yield`.

Exports `RoundRobinScheduler`, `IScheduler`, `ISchedulerOptions`, `IJobResult`, `TaskCancelledError`.

### `task.ts`

Wraps a generator, registers it with the scheduler, and connects each step to the promise and the emitter.

Also holds `TaskHelper` — the second strategy in the library. The helper decides when a generator should offer to pause. `SimpleTaskHelper` does it by wall clock; you could write one that consults `navigator.scheduling.isInputPending()`, or that adapts its threshold, or that respects priorities.

Exports `taskBuilder`, `SimpleTaskHelper`, `TaskHelper`, `TaskHelperConstructor`, `TaskBuilder`, `EventablePromise`.

## API

### `new RoundRobinScheduler({ quota, delay })`

| Option | Meaning |
|---|---|
| `quota` | Milliseconds the thread may be held per tick, **for all tasks combined**. This is the maximum delay you impose on everything else in the thread. |
| `delay` | Milliseconds to sleep between ticks. Controls the CPU share, not responsiveness. |

| Member | Description |
|---|---|
| `quota`, `delay` | Read-only getters |
| `isRunning()` | Whether the loop is currently turning |
| `push(job, handler)` | Register an iterator; `handler` is called with every step result. Returns the queue length |
| `run()` | Start the loop. Idempotent, `push` calls it for you |
| `clear()` | Cancel everything: close generators, settle promises, cancel the pending timer |

### `taskBuilder(scheduler)(Helper)(generator)`

Returns a function that takes your generator's arguments minus the leading helper, and returns an `EventablePromise`.

### `EventablePromise`

| Member | Description |
|---|---|
| `await` | The generator's `return` value |
| `.on("data", h)` | Every step, as `{ done, value }`. Returns itself for chaining |
| `.on("error", h)` | `{ done: true, error, value: undefined }`. Returns itself |
| `.off(event?, handler?)` | Drop one handler, all handlers of one event, or everything |
| `for await` | Yields intermediate values; ends on the final step |
| `.then` / `.catch` / `.finally` | Standard behaviour, and the result stays eventable |

### `TaskHelper`

```ts
interface TaskHelper {
  shouldPause(): boolean;
}
```

`SimpleTaskHelper` returns `true` once `quota / 4` milliseconds have passed since the step began.

## Tuning quota and delay

The two knobs do different jobs and are easy to confuse.

| Knob | Governs | Turn it for |
|---|---|---|
| `quota` | Longest uninterrupted block | Responsiveness |
| `delay` | Share of CPU given away | Throughput |

Real block length is about `quota × 1.25`, because the budget is checked *after* a step completes, so the last step always overshoots. The task's CPU share is roughly `quota / (quota + delay)`.

| quota | delay | Block | CPU | Use |
|---|---|---|---|---|
| 300 | 50 | ~375 ms | 86% | Never. This is the "before" picture |
| 16 | 8 | ~20 ms | 67% | Frame boundary, slight jitter |
| **8** | **4** | **~10 ms** | **67%** | Good default, fits inside a frame |
| 5 | 0 | ~6 ms | ~85% | What you would ship |
| 4 | 2 | ~5 ms | 67% | React Fiber's budget, smoothest |

`delay: 0` is not a typo. Node clamps it to about 1 ms, which is enough for timers and I/O to run. The point is to *hand over* control, not to idle. Going below `quota: 4` is not worth it: `setTimeout` clamping (1 ms in Node, 4 ms for nested timers in browsers) starts eating a visible share of the tick.

Reference numbers: 16.6 ms is one frame at 60 FPS, 50 ms is the Core Web Vitals "long task" threshold, 5 ms is roughly React Fiber's slice.

### Measured

Same workload, same 10 ms heartbeat, only the settings changed.

```
quota: 300, delay: 50     heartbeat silent for ~350 ms at a stretch
quota: 8,   delay: 4      heartbeat +11ms, +20ms
```

Worst-case stall dropped by a factor of about seventeen. Total wall-clock time went up, which is the trade you are making.

## How it works

### The scheduler loop

```
push(job) → queueMicrotask(loop)
              │
              ├─ shift a task off the queue
              ├─ run one step: job.next()
              ├─ not finished? push it to the back      ← round robin
              ├─ call handler(result)
              │
              ├─ under quota? → loop again, synchronously
              └─ over quota?  → setTimeout(loop, delay) ← the actual yield
```

The budget is soft. The check happens after a step returns, so a step that never calls `shouldPause()` will hold the thread for as long as it likes and the scheduler will find out only afterwards. This is inherent to cooperative scheduling, not a flaw in the implementation. It is exactly why Go added asynchronous preemption in 1.14.

### Why `queueMicrotask` is not a yield point

Microtasks drain completely before the event loop moves on, ahead of rendering and ahead of the next macrotask. Scheduling continuation as a microtask reorders your calls without ever releasing the thread:

```js
// Never yields. The page stays dead.
const loop = () => { work(); queueMicrotask(loop); };
```

The library uses `queueMicrotask` exactly once, to defer the *start* of the loop so that the caller can attach handlers and begin iterating before the first data arrives. The real yield is always `setTimeout`.

A production version would make the exit point a strategy and pick `MessageChannel` (a macrotask with no clamping), `setImmediate` (Node, runs after I/O), or `scheduler.yield()` (modern Chrome) per platform.

### The buffer in EventEmitter

Symmetrical logic on both sides:

- **Data arrives.** Someone waiting? Hand it over. Nobody? Buffer it.
- **`next()` is called.** Something buffered? Return it immediately. Nothing? Join the queue of waiters.

Three consequences worth knowing:

**A queue of resolvers, not a single field.** With one shared promise, two concurrent `next()` calls would receive the same promise and therefore the same value, which violates the async iterator contract.

**The internal sink is separate from the public handler sets.** Feeding the buffer through `this.on("data", ...)` would be fragile: a user calling `off()` with no arguments does `store.clear()` and would wipe out the library's own subscription. So `emit` calls the internal sink explicitly first, then walks the public sets.

**Buffering is lazy.** It switches on at the first `[Symbol.asyncIterator]()` call. Buffering from construction would mean that a consumer using only `.on("data")`, who never iterates, accumulates every chunk for the lifetime of the task — trading dropped data for a memory leak. The cost of laziness is that you must start iterating before your first `await`. In practice `for await` is set up synchronously and the scheduler starts on a microtask, so the window is closed.

### Cancellation

`scheduler.clear()` does four things, and all four matter:

1. **Cancels the pending `setTimeout`.** Otherwise a `push()` arriving between `clear()` and the timer firing flips `#running` back to `true`, and the old timer starts a *second* loop over the same queue.
2. **Bumps an epoch counter.** A queued `queueMicrotask` cannot be cancelled, so each loop captures the epoch at start and dies quietly when it no longer matches. Same race, different scheduling primitive.
3. **Closes generators via `job.return()`.** This is what makes `finally` blocks inside user generators run, so resources get released.
4. **Settles every live task's promise** with `TaskCancelledError`. Without it those promises hang forever.

Note that `clear()` empties the queue with `splice` rather than assigning a new array. Same result, but the allocated capacity is kept instead of being rebuilt on the next `push`.

### EventablePromise

Rather than subclassing `Promise`, the library defines properties on an ordinary one. `then`, `catch` and `finally` are overridden to recursively re-apply the decoration to the derived promise, which is what keeps `exec(n).catch(console.error)` iterable.

Two details: the originals are taken from `Promise.prototype`, not from the object, so an already-overridden method is never captured; and all properties are declared `configurable` and `writable`, so the shape stays consistent.

Errors reject with `result.error` rather than the `{ done, error, value }` wrapper, so stack traces and `instanceof` survive. The wrapper is still delivered intact to `.on("error")`.

The library also attaches a silent `promise.catch(() => {})` internally. Without it, handling errors solely through `.on("error")` would leave an unhandled rejection, which crashes the process by default on Node 15+. The trade-off: if you attach neither `.catch` nor `on("error")`, the error disappears quietly.

## Demos

| Command | What to watch |
|---|---|
| `npm run demo:problem` | Heartbeat goes silent for seconds |
| `npm run demo:cooperative` | Heartbeat holds ~10–20 ms; all three interfaces |
| `npm run demo:parallel` | A/B interleaving; adding tasks does not lengthen the stall |
| `npm run demo:cancel` | The `finally` line prints, the error carries a stack, the process exits |
| `npm run demo:error` | Both error paths; the process survives an uncaught-by-promise failure |

Two things in the output are worth understanding.

**Four `on(data)` lines in a row.** A step lasts `quota / 4` and the budget is checked afterwards: 2, 4, 6, 8 ms, and at 8 the tick ends.

**Chunks grow from ~3,500 to ~41,000.** The window is a constant 2 ms, but twelve times as much work fits into it. That is JIT warm-up: the first chunks run interpreted, then the function turns hot and gets optimized.

The practical lesson: **budget in milliseconds, never in iterations.** A `shouldPause()` that fired every 10,000 elements would produce a 6 ms stall cold and a 0.5 ms stall warm. Same threshold, wildly different freeze.

## Known limitations

Deliberate, and left visible. This is a study repository.

**Recursion instead of a loop.** `run()` calls itself, growing the stack. With a large `quota` and very short steps this can reach `RangeError: Maximum call stack size exceeded`. Production code needs `while`.

**`handler` is called inside `try`.** If a user handler throws, the `catch` fires and `handler` runs a second time, with an error result.

**`#done` is never set to `true`.** The field is read in `next()` but never written. Harmless on the normal path, since `for await` terminates on `{ done: true }` from the buffer and stops calling `next()`. An explicit `next()` after completion will hang.

**`any` on the left of `extends` in `TaskBuilder`.** A conditional type with `any` on the left expands to a union of both branches, so `infer D` and `infer R` never resolve and chunk types collapse to `unknown`. Demos cast around it. The fix is `F extends ...`.

**No backpressure.** The emitter's buffer grows without limit if the consumer is slower than the producer. In practice the scheduler saves you: the consumer drains during the `delay` pause, so the buffer holds roughly `quota / step` items.

**No per-task cancellation.** Only `scheduler.clear()`, which cancels everything. A real API would take an `AbortSignal` or return a handle instead of `push` returning a queue length nobody can use.

**No priorities.** Round robin is perfectly fair, which is not always right: reacting to input should preempt a background recalculation.

**No `return()` on the async iterator.** Breaking out of `for await` leaves pending waiters uncleaned.

**The measurement costs something.** `shouldPause()` calls `performance.now()` on every iteration of your loop — four million calls at `n = 2_000_000`. On short steps that is a visible share of the step. A counter that checks the clock every 1024 iterations would fix it.

**Array used as a deque.** `shift()` is O(n). A ring buffer would be correct.

**No tests.** A minimal set would cover: chunks are not dropped, the stack does not overflow, `clear()` settles promises, errors reach both interfaces, two tasks interleave.

## When to use this, and when not to

**Good fits.** Filtering, sorting or indexing hundreds of thousands of rows already in memory. Progressive rendering of a virtualized list. Incremental text work such as syntax highlighting, markdown parsing, diffing. Walking large trees or graphs, where `yield*` makes recursive traversal read normally while a hand-written state machine would need an explicit stack. Anything that needs closures, caches or the DOM, where moving data to a worker costs more than the computation.

**Bad fits.** Atomic operations you cannot cut in half: `JSON.parse`, `structuredClone`, a catastrophically backtracking regex. Third-party synchronous code you will not rewrite. Batch work where throughput matters and nobody is waiting on the thread. Server-side number crunching under load, where a worker pool gives you real parallelism across cores instead of dividing one core.

**Combine them.** The strongest setup is a worker that is itself written cooperatively, so it stays responsive to messages and can round-robin several jobs. This library runs unchanged inside a worker.

For large JSON specifically, cooperative scheduling helps little: `JSON.parse` is atomic and cannot be paused. Use a streaming parser (`stream-json`, `clarinet`, `oboe`) or parse in a worker. Cooperative scheduling is for *processing* the parsed data.

## License

MIT
