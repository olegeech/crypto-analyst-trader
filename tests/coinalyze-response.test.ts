import assert from "node:assert/strict";
import test from "node:test";

import { parseCoinalyzeJson } from "../src/adapters/coinalyze/coinalyze-response.js";

test("JSON parsing preserves provider numeric lexemes for exact decimal mapping", () => {
  const parsed = parseCoinalyzeJson(
    '[{"t":1790000000,"l":0.00000000000000001,"s":1e-7,"label":"1.25"}]',
  );

  assert.deepEqual(parsed, [
    {
      t: "1790000000",
      l: "0.00000000000000001",
      s: "1e-7",
      label: "1.25",
    },
  ]);
});

test("numeric-looking text and escaped quotes inside JSON strings are unchanged", () => {
  const parsed = parseCoinalyzeJson(
    '{"value":"1.2300","quoted":"say \\\"t=42\\\"","nested":[true,null,-2]}',
  );

  assert.deepEqual(parsed, {
    value: "1.2300",
    quoted: 'say "t=42"',
    nested: [true, null, "-2"],
  });
});

test("malformed JSON remains a parse failure", () => {
  assert.throws(() => parseCoinalyzeJson('[{"value":1e}]'));
  assert.throws(() => parseCoinalyzeJson("not-json"));
});
