#!/usr/bin/env node
import process from "node:process";
import { defaultCliIo, runContractCli } from "./cli-run.js";

/**
 * Contract validation command (PRD Phase 07 task 10).
 *
 * Phase 11 exposes the same operations as `flightrules contract validate`; this is the executable
 * form that exists as soon as the validator does, so a contract can be checked in CI before the
 * product CLI is built. All logic lives in `cli-run.ts`, which is unit-tested with injected streams.
 */
process.exit(runContractCli(process.argv.slice(2), defaultCliIo()));
