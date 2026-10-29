/** Verify installer refusal on native release artifacts, including Windows. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [binary, ...prefix] = process.argv.slice(2);
assert.ok(binary, "expected a binary path");
const scratch = mkdtempSync(join(tmpdir(), "plannotator-update-smoke-"));
let requests = 0;
const mirror = createServer((_req, res) => {
  requests++;
  res.writeHead(503);
  res.end("No installer is served by this smoke test.");
});

try {
  await new Promise((done, fail) => {
    mirror.once("error", fail);
    mirror.listen(0, "127.0.0.1", done);
  });
  const base = `http://127.0.0.1:${mirror.address().port}`;
  const env = {
    ...process.env,
    HOME: join(scratch, "home"), USERPROFILE: join(scratch, "home"),
    LOCALAPPDATA: join(scratch, "AppData", "Local"), APPDATA: join(scratch, "AppData", "Roaming"),
    PLANNOTATOR_DATA_DIR: join(scratch, "tmp", "data"),
    TMPDIR: join(scratch, "tmp"), TMP: join(scratch, "tmp"), TEMP: join(scratch, "tmp"),
    PLANNOTATOR_AUTO_UPDATE: "1", PLANNOTATOR_UPDATE_CHECK: "1",
    PLANNOTATOR_UPDATE_LATEST_URL: `${base}/latest`, PLANNOTATOR_UPDATE_API_URL: `${base}/api/latest`,
    PLANNOTATOR_INSTALL_SCRIPT_URL: `${base}/install`, PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${base}/dl`,
  };
  for (const path of [env.HOME, env.LOCALAPPDATA, env.APPDATA, env.PLANNOTATOR_DATA_DIR, env.TMPDIR]) {
    mkdirSync(path, { recursive: true });
  }
  for (const args of [["update"], ["update", "--check"], ["update-prepare", "v999.0.0"]]) {
    const child = spawn(resolve(binary), [...prefix, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (part) => { output += part; });
    child.stderr.on("data", (part) => { output += part; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    let code;
    try {
      code = await new Promise((done, fail) => {
        child.once("error", fail);
        child.once("close", done);
      });
    } finally {
      clearTimeout(timer);
    }
    const diagnostic = `${args.join(" ")} exited ${code}:\n${output}`;
    assert.ok(typeof code === "number" && code !== 0, diagnostic);
    assert.match(output, /Installer updates are disabled/, diagnostic);
    assert.match(output, /github\.com\/cboone\/plannotator/, diagnostic);
    assert.equal(requests, 0, `${diagnostic}\nUnexpected mirror requests: ${requests}`);
  }
  console.log("OK: installer updates refused without network requests");
} finally {
  await new Promise((done) => mirror.close(done));
  rmSync(scratch, { recursive: true });
}
