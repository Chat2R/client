import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowsTaskXml } from "../src/service.js";

test("Windows service task is unattended, persistent, and rooted", () => {
  const xml = buildWindowsTaskXml({
    server: "https://chat2r.ender.com.pl",
    roots: ["C:\\Projects", "D:\\Scratch"],
    allowShell: false
  }, "C:\\Program Files\\nodejs\\node.exe");

  assert.match(xml, /Chat2R unattended machine client/);
  assert.match(xml, /--unattended/);
  assert.match(xml, /--no-open/);
  assert.match(xml, /--no-shell/);
  assert.match(xml, /C:\\Projects/);
  assert.match(xml, /D:\\Scratch/);
  assert.match(xml, /RestartOnFailure/);
  assert.match(xml, /PT1M/);
  assert.match(xml, /MultipleInstancesPolicy>IgnoreNew/);
  assert.match(xml, /service\.log/);
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.doesNotMatch(xml, /cmd\.exe/i);
});
