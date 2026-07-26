# The worker exited silently when idle — diagnosis and proof of fix

## How it surfaced

A background worker process ended with exit code 13 after a session in which every job it
logged had succeeded. Node's own words, the last line it wrote:

    Warning: Detected unsettled top-level await at .../apps/worker/dist/index.js:88
        await runner.loop();

## Cause

`JobRunner.loop()` called `timer.unref()` on its idle poll timer. An unref'ed timer does not
keep the Node event loop alive. While the worker is idle that timer is the *only* pending
handle — `postgres.js` closes idle connections and takes its sockets with them — so the loop
drained and the process exited, with `await runner.loop()` still pending.

The failure is silent: nothing is logged, the exit code is not 1, and every job before it
succeeded. Afterwards every submitted job sits `queued` with nothing to claim it. This is
exactly the symptom hit earlier in the Phase 13 session, where a browser baseline capture
stayed at QUEUED and the worker was found to be absent.

Two other `unref()` calls in this application are correct and were left alone: the lease
heartbeat (the job's own promise keeps the process alive) and the shutdown timeout (the
shutdown sequence does).

## Proof of fix, against the built worker

    node apps/worker/dist/index.js       # started, then left with nothing to do

  idle uptime before any work arrived    6m 08s
  jobs claimed during that idle period   0
  process alive after the idle period    yes

Work was then submitted by `make demo-full`:

  jobs claimed by the previously-idle worker   5
  make demo-full                               exit 0
  approved release refund-agent-v1             exit 0
  unsafe canary    refund-agent-v2             exit 2
  worker uptime afterwards                     7m 52s, still running

Before the fix the process would not have survived the idle period at all.

## Regression tests

`apps/worker/src/runner.integration.test.ts`:

  - the real `loop()` is driven across several idle polls, then a job is submitted, and the
    loop is required to claim it — idle first, work second, which is the sequence that broke;
  - the poll timer is asserted directly not to be unref'ed, because the behavioural test alone
    would still pass if something unrelated happened to hold the event loop open, which is
    exactly how the original defect survived.
