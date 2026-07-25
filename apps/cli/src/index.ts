#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./main.js";
import type { Io } from "./output.js";

/**
 * The process wrapper.
 *
 * Everything the CLI can observe or change about the outside world is bound here and nowhere else,
 * so `run` is a pure-ish function of its arguments and a test never has to stub a global. This file
 * is deliberately the only place that touches `process`.
 */

const io: Io = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  env: process.env,
  fetch: globalThis.fetch,
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, contents) => writeFile(path, contents, "utf8"),
  appendFile: (path, contents) => appendFile(path, contents, "utf8"),
  now: () => new Date(),
  sleep: (ms) => delay(ms),
};

// `process.exitCode` rather than `process.exit`, so buffered stdout is flushed before the process
// ends. `process.exit` truncates a large JSON document on a pipe.
run(process.argv.slice(2), io)
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    // Nothing reaches here that `run` did not already classify, so this is the reserved code for
    // "the process failed before it could decide anything". It is never 0.
    process.stderr.write("flightrules: the CLI failed before it could classify the outcome\n");
    process.exitCode = 1;
  });

export { run } from "./main.js";
export type { Io } from "./output.js";
