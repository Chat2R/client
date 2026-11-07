import assert from "node:assert/strict";
import test from "node:test";
import { buildWindowsLauncher, buildWindowsTaskXml } from "../src/service.js";

test("Windows service task is unattended, persistent, and rooted", () => {
  const xml = buildWindowsTaskXml({
    server: "https://chat2r.ender.com.pl",
    roots: ["C:\\Projects", "D:\\Scratch"],
    allowShell: false
  }, "C:\\Program Files\\nodejs\\node.exe");

  assert.match(xml, /Chat2R unattended machine client/);
  assert.match(xml, /service-launcher\.vbs/);
  assert.match(xml, /C:\\Projects/);
  assert.match(xml, /RestartOnFailure/);
  assert.match(xml, /PT1M/);
  assert.match(xml, /MultipleInstancesPolicy>IgnoreNew/);
  assert.match(xml, /service-launcher\.vbs/);
  assert.match(xml, /wscript\.exe/i);
  assert.match(xml, /\/\/B \/\/Nologo/);
  assert.doesNotMatch(xml, /node\.exe<\/Command>/i);

  const launcher = buildWindowsLauncher({
    server: "https://chat2r.ender.com.pl",
    roots: ["C:\\Projects", "D:\\Scratch"],
    allowShell: false
  }, "C:\\Program Files\\nodejs\\node.exe");
  assert.match(launcher, /WScript\.Shell/);
  assert.match(launcher, /shell\.Run\(/);
  assert.match(launcher, /, 0, True\)/);
  assert.match(launcher, /--unattended/);
  assert.match(launcher, /--no-open/);
  assert.match(launcher, /--no-shell/);
  assert.match(launcher, /C:\\Projects/);
  assert.match(launcher, /D:\\Scratch/);
  assert.match(launcher, /--log-file/);
});
