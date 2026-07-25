import { describe, expect, it } from "vitest";
import { RefundLedger } from "./ledger.js";

const SALT = "0123456789abcdef0123456789abcdef";

describe("refund ledger", () => {
  it("records one entry for a first refund", () => {
    const ledger = new RefundLedger(SALT);
    const outcome = ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 4820,
      idempotencyKey: "key-a",
      attempt: 1,
    });

    expect(outcome.deduplicated).toBe(false);
    expect(ledger.entries()).toHaveLength(1);
    expect(outcome.refundId).toMatch(/^rfnd_[a-f0-9]{20}$/);
  });

  it("returns the original refund without writing again when the same key is replayed", () => {
    const ledger = new RefundLedger(SALT);
    const first = ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 4820,
      idempotencyKey: "key-a",
      attempt: 1,
    });
    const replay = ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 4820,
      idempotencyKey: "key-a",
      attempt: 2,
    });

    expect(replay.deduplicated).toBe(true);
    expect(replay.refundId).toBe(first.refundId);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.duplicatedSideEffects()).toEqual([]);
  });

  it("refunds the same order twice when the retry changes the idempotency key", () => {
    // This is the unsafe v2 behaviour, reproduced at the level the payment service can observe:
    // it has no way to recognise the second request as the same logical operation.
    const ledger = new RefundLedger(SALT);
    ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 4820,
      idempotencyKey: "key-a1",
      attempt: 1,
    });
    ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 4820,
      idempotencyKey: "key-a2",
      attempt: 2,
    });

    expect(ledger.entriesForOrder("ord-1")).toHaveLength(2);
    expect(ledger.duplicatedSideEffects()).toEqual([
      {
        runId: "run_1",
        orderId: "ord-1",
        count: 2,
        refundIds: expect.arrayContaining([expect.any(String)]),
      },
    ]);
  });

  it("refunds the same order twice when no idempotency key is supplied at all", () => {
    const ledger = new RefundLedger(SALT);
    ledger.record({ orderId: "ord-1", runId: "run_1", amountCents: 4820, attempt: 1 });
    ledger.record({ orderId: "ord-1", runId: "run_1", amountCents: 4820, attempt: 2 });

    expect(ledger.entriesForOrder("ord-1")).toHaveLength(2);
    expect(ledger.duplicatedSideEffects()[0]?.count).toBe(2);
  });

  it("never stores the raw idempotency key", () => {
    const ledger = new RefundLedger(SALT);
    ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 4820,
      idempotencyKey: "super-secret-key-value",
      attempt: 1,
    });

    const serialised = JSON.stringify(ledger.entries());
    expect(serialised).not.toContain("super-secret-key-value");
    expect(ledger.entries()[0]?.idempotencyKeyHash).toMatch(/^sha256:[a-f0-9]{32}$/);
  });

  it("produces a stable hash for the same key and different hashes for different keys", () => {
    const ledger = new RefundLedger(SALT);
    expect(ledger.hashKey("key-a")).toBe(ledger.hashKey("key-a"));
    expect(ledger.hashKey("key-a")).not.toBe(ledger.hashKey("key-b"));
  });

  it("produces different hashes for the same key under a different salt", () => {
    const a = new RefundLedger(SALT);
    const b = new RefundLedger("fedcba9876543210fedcba9876543210");
    expect(a.hashKey("key-a")).not.toBe(b.hashKey("key-a"));
  });

  it("rejects a salt too short to be useful", () => {
    expect(() => new RefundLedger("short")).toThrow(/at least 16 characters/);
  });

  it("reports no duplicates when different orders are each refunded once", () => {
    const ledger = new RefundLedger(SALT);
    ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 100,
      idempotencyKey: "k1",
      attempt: 1,
    });
    ledger.record({
      orderId: "ord-2",
      runId: "run_2",
      amountCents: 200,
      idempotencyKey: "k2",
      attempt: 1,
    });
    expect(ledger.duplicatedSideEffects()).toEqual([]);
  });

  it("clears every entry on reset", () => {
    const ledger = new RefundLedger(SALT);
    ledger.record({
      orderId: "ord-1",
      runId: "run_1",
      amountCents: 100,
      idempotencyKey: "k1",
      attempt: 1,
    });
    ledger.reset();

    expect(ledger.entries()).toEqual([]);
    expect(ledger.duplicatedSideEffects()).toEqual([]);
    // A replayed key after reset writes a new entry, proving the index was cleared too.
    expect(
      ledger.record({
        orderId: "ord-1",
        runId: "run_1",
        amountCents: 100,
        idempotencyKey: "k1",
        attempt: 1,
      }).deduplicated,
    ).toBe(false);
  });
});
