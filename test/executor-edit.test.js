import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor } from "../src/executor.js";

function withExecutor(run) {
  const root = mkdtempSync(join(tmpdir(), "chat2r-edit-"));
  const executor = createExecutor({ roots: [root], allowShell: false });
  try {
    return run({ root, executor });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("exact edit treats replacement text literally", () => {
  withExecutor(({ root, executor }) => {
    const path = join(root, "literal.txt");
    writeFileSync(path, "alpha beta\n", "utf8");

    executor.editFile({
      file_path: path,
      old_string: "beta",
      new_string: "$& literal"
    });

    assert.equal(readFileSync(path, "utf8"), "alpha $& literal\n");
  });
});

test("whitespace-tolerant edit ignores indentation and newline spacing", () => {
  withExecutor(({ root, executor }) => {
    const path = join(root, "space.js");
    writeFileSync(path, "function x() {\n        return 1;\n}\n", "utf8");

    const result = executor.editFile({
      file_path: path,
      old_string: "function x() {\n  return 1;\n}",
      new_string: "function x() {\n  return 2;\n}",
      ignore_whitespace: true
    });

    assert.equal(result.ignore_whitespace, true);
    assert.equal(readFileSync(path, "utf8"), "function x() {\n  return 2;\n}\n");
  });
});

test("regex edit supports capture replacements", () => {
  withExecutor(({ root, executor }) => {
    const path = join(root, "regex.txt");
    writeFileSync(path, "port=1234\n", "utf8");

    const result = executor.editFile({
      file_path: path,
      old_string: "port=(\\d+)",
      new_string: "port=$1-updated",
      match_mode: "regex"
    });

    assert.equal(result.match_mode, "regex");
    assert.equal(readFileSync(path, "utf8"), "port=1234-updated\n");
  });
});

test("regex edit rejects ambiguous and zero-width patterns", () => {
  withExecutor(({ root, executor }) => {
    const path = join(root, "guard.txt");
    writeFileSync(path, "x x\n", "utf8");

    assert.throws(() => executor.editFile({
      file_path: path,
      old_string: "x",
      new_string: "y",
      match_mode: "regex"
    }), /occurs 2 times/);

    assert.throws(() => executor.editFile({
      file_path: path,
      old_string: "^",
      new_string: "prefix",
      match_mode: "regex"
    }), /must not match an empty string/);
  });
});

test("applyPatch forwards regex and whitespace matching options", () => {
  withExecutor(({ root, executor }) => {
    const path = join(root, "patch.txt");
    writeFileSync(path, "name   =   old\n", "utf8");

    const result = executor.applyPatch({
      operations: [{
        type: "replace",
        file_path: path,
        old_string: "name = old",
        new_string: "name = new",
        ignore_whitespace: true
      }]
    });

    assert.equal(result.results[0].ignore_whitespace, true);
    assert.equal(readFileSync(path, "utf8"), "name = new\n");
  });
});
