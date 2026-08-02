import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonlDecoder, parseWorkerMessage } from "./protocol.js";

describe("JSONL protocol", () => {
  it("decodes fragmented and coalesced messages", () => {
    const decoder = new JsonlDecoder();

    assert.deepEqual(decoder.push('{"type":"hello"'), []);
    assert.deepEqual(decoder.push(',"runId":"run-1","version":1}\n{"type":"ready","runId":"run-1","version":1}\n'), [
      { type: "hello", runId: "run-1", version: 1 },
      { type: "ready", runId: "run-1", version: 1 },
    ]);
  });

  it("preserves UTF-8 characters split across socket chunks", () => {
    const decoder = new JsonlDecoder();
    const encoded = Buffer.from('{"type":"progress","runId":"run-1","version":1,"message":"Atalanta · 完"}\n');
    const splitAt = encoded.indexOf(Buffer.from("完")) + 1;

    assert.deepEqual(decoder.push(encoded.subarray(0, splitAt)), []);
    assert.equal(decoder.push(encoded.subarray(splitAt))[0]?.["message"], "Atalanta · 完");
  });

  it("rejects malformed JSON and protocol envelopes", () => {
    const decoder = new JsonlDecoder();

    assert.throws(() => decoder.push("not json\n"), /Invalid JSONL/);
    assert.throws(() => parseWorkerMessage({ type: "ready", runId: "run-1", version: 2 }), /protocol version/);
    assert.throws(() => parseWorkerMessage({ type: "ready", version: 1 }), /runId/);
  });
});
