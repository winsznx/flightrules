import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalJson, canonicalObject } from "./canonical.js";
import { readCanonicalGraph } from "./read-canonical.js";

describe("canonicalJson", () => {
  it("orders object keys lexicographically at every depth", () => {
    // #given two objects that differ only in the order their keys were written
    const a = { z: 1, a: { d: 4, b: { y: 2, x: 1 } } };
    const b = { a: { b: { x: 1, y: 2 }, d: 4 }, z: 1 };

    // #then their canonical forms are byte-identical
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"b":{"x":1,"y":2},"d":4},"z":1}');
  });

  it("preserves array order, because an array's order is meaning", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("drops undefined properties rather than writing null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("refuses a non-finite number instead of silently writing null", () => {
    // #given JSON.stringify turns NaN and Infinity into null, which would store a wrong value
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it("refuses a value JSON cannot represent", () => {
    expect(() => canonicalJson({ fn: () => 1 })).toThrow(/cannot be stored as JSON/);
  });

  it("hashes equal for reordered inputs and differs for changed ones", () => {
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });

  it("produces a plain object ready for a jsonb parameter", () => {
    expect(canonicalObject({ b: [1, { d: 1, c: 2 }], a: "x" })).toEqual({
      a: "x",
      b: [1, { c: 2, d: 1 }],
    });
  });
});

describe("readCanonicalGraph", () => {
  const graph = {
    normaliserVersion: "1.0.0",
    normaliserConfigHash: "a".repeat(64),
    nodes: [
      {
        order: 0,
        depth: 0,
        label: "refund.request",
        service: "demo",
        kind: "Server",
        sideEffect: "none",
        tool: null,
        dataDomain: null,
        retryNumber: null,
        // Lexicographic order, as `canonicaliseGraph` produces it.
        attributes: { "agent.side_effect": "none", zz: "1" },
      },
    ],
    edges: [{ from: 0, to: 0, type: "parent" }],
  };

  it("restores lexicographic attribute order after a jsonb-style reordering", () => {
    // #given PostgreSQL jsonb returns object keys by length then bytes, so a two-character key
    // sorts before a sixteen-character one regardless of the order it was written in
    const asStoredByPostgres = {
      ...graph,
      nodes: [{ ...graph.nodes[0], attributes: { zz: "1", "agent.side_effect": "none" } }],
    };

    // #when the row is read back
    const restored = readCanonicalGraph(asStoredByPostgres);

    // #then the attribute key order matches the in-memory canonical form exactly
    expect(Object.keys(restored.nodes[0]?.attributes ?? {})).toEqual(["agent.side_effect", "zz"]);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(graph));
  });

  it("refuses a column that does not hold an object", () => {
    expect(() => readCanonicalGraph("not a graph")).toThrow(/did not contain an object/);
  });
});
