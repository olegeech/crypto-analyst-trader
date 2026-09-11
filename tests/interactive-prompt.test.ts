import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  PromptInterruptedError,
  promptVisible,
} from "../src/cli/interactive-prompt.js";

function terminalStreams() {
  return {
    input: Object.assign(new PassThrough(), { isTTY: true }),
    output: new PassThrough(),
  };
}

test("visible prompt resolves the entered line", async () => {
  const streams = terminalStreams();
  const answer = promptVisible("Choose an option", undefined, streams);
  streams.input.write("2\n");

  assert.equal(await answer, "2");
});

test("visible prompt requires terminal input", () => {
  assert.throws(
    () =>
      promptVisible("Choose an option", "Needs a terminal.", {
        input: new PassThrough(),
        output: new PassThrough(),
      }),
    /Needs a terminal/,
  );
});

test("visible prompt wait is bounded", async () => {
  const streams = terminalStreams();

  await assert.rejects(
    promptVisible("Choose an option", undefined, {
      ...streams,
      timeoutMs: 10,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PromptInterruptedError);
      assert.equal(error.reason, "timeout");
      return true;
    },
  );
});

test("end of terminal input cancels the prompt instead of hanging", async () => {
  const streams = terminalStreams();
  const answer = promptVisible("Choose an option", undefined, streams);
  streams.input.end();

  await assert.rejects(answer, (error: unknown) => {
    assert.ok(error instanceof PromptInterruptedError);
    assert.equal(error.reason, "cancelled");
    return true;
  });
});
