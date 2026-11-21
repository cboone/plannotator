/** Runs only as a bundled child, with the same build define as fork releases. */
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { mock } from "bun:test";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { assertSandboxedDataDir } from "./real-data-dir";

// Block real installer execution when testing removed guards.
mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: () => { throw new Error("installer spawn reached"); },
}));

const dataDir = assertSandboxedDataDir("update-policy-probe");
process.env.PLANNOTATOR_DATA_DIR = dataDir;
const updates = await import("../../packages/server/auto-update");
const prepare = await import("../../packages/server/update-prepare");
const { runUpdateCommand } = await import("../../apps/hook/server/update-command");
const { patchUpdateState } = await import("../../packages/shared/update-check");
const fixtureRoot = process.env.PLANNOTATOR_POLICY_FIXTURE_ROOT!;
// Check both path grammars before any fixture write, including on POSIX hosts.
if (process.argv[2]?.startsWith("advert-")) {
  assert.ok(fixtureRoot);
  for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PLANNOTATOR_DATA_DIR"]) {
    const path = process.env[key];
    assert.ok(path, `${key} must be isolated`);
    const part = relative(resolve(fixtureRoot), resolve(path));
    assert.ok(part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part), `${key} escaped fixture`);
  }
  const windowsPath = updates.managedBinaryPath("win32", process.env, fixtureRoot);
  const part = win32.relative(win32.resolve(fixtureRoot), win32.resolve(windowsPath));
  assert.ok(part !== ".." && !part.startsWith("..\\") && !win32.isAbsolute(part), "Windows managed path escaped fixture");
}
const unexpected = () => { throw new Error("update side effect reached"); };
const launch = {
  version: "v0.28.38", platform: "darwin" as const, flags: [],
  logPath: join(dataDir, "update.log"), resultPath: join(dataDir, "update-result.json"),
  lockPath: join(dataDir, "update.lock"),
};
const manual = {
  currentVersion: "0.28.37", dataDir, now: () => 1_800_000_000_000,
  platform: "darwin" as const, isManaged: () => true,
};
if (process.argv[2] === "update") {
  process.exit(await runUpdateCommand(process.argv.slice(3), { currentVersion: manual.currentVersion }));
}
if (process.argv[2] === "update-prepare") {
  process.exit(await prepare.runUpdatePrepareCommand(process.argv.slice(3), { platform: process.platform }));
}
patchUpdateState(() => ({ latestRelease: { tag: "0.28.38", fetchedAt: manual.now() } }), dataDir);
const mode = process.argv[2];
switch (mode) {
  case "automatic":
    assert.equal(await updates.runAutoUpdateCheck({
      ...manual, execPath: "/unused", pid: 1, enabled: () => true,
      fetchReleasePage: unexpected, fetchRelease: unexpected,
      listSessions: unexpected, launchInstaller: unexpected,
    }), "disabled");
    break;
  case "manual":
    assert.deepEqual(updates.startManualUpdate({ ...manual, launchInstaller: unexpected }), { outcome: "disabled" });
    break;
  case "detached":
    assert.throws(() => updates.launchInstaller(launch), /Installer updates are disabled/);
    break;
  case "foreground":
    await assert.rejects(updates.runInstallerForeground(launch, unexpected), /Installer updates are disabled/);
    break;
  case "prepare":
    assert.deepEqual(await prepare.prepareUpdate({
      version: launch.version, platform: "darwin", fetchImpl: unexpected,
    }), { ok: false, error: updates.UPDATE_INSTALLATION_DISABLED_MESSAGE });
    break;
  case "prepare-command": {
    let error = "";
    const staged = mkdtempSync(join(dataDir, "plannotator-update-"));
    utimesSync(staged, 1, 1);
    assert.equal(await prepare.runUpdatePrepareCommand([launch.version], {
      platform: "darwin", fetchImpl: unexpected, out: unexpected,
      // Must refuse before inspecting or sweeping a staging directory.
      tmpRoot: dataDir, err: (s) => { error += s; },
    }), prepare.UPDATE_PREPARE_FAILED);
    assert.match(error, /Installer updates are disabled/);
    assert.equal(existsSync(staged), true);
    break;
  }
  case "cli":
  case "cli-check": {
    let error = "";
    assert.equal(await runUpdateCommand(mode === "cli-check" ? ["--check"] : [], {
      ...manual, env: { PLANNOTATOR_AUTO_UPDATE: "1" },
      fetchReleasePage: unexpected, fetchRelease: unexpected, runInstaller: unexpected,
      out: unexpected, err: (s) => { error += s; },
    }), 1);
    assert.match(error, /github\.com\/cboone\/plannotator/);
    assert.match(error, /verify/);
    assert.doesNotMatch(error, /curl|install\.sh/);
    break;
  }
  case "advert-active":
  case "advert-auto":
  case "advert-release": {
    const managedPath = updates.managedBinaryPath();
    mkdirSync(dirname(managedPath), { recursive: true });
    writeFileSync(managedPath, "fixture executable identity");
    const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
    try {
      Object.defineProperty(process, "execPath", { value: managedPath });
      process.env.PLANNOTATOR_AUTO_UPDATE = "1";
      process.env.PLANNOTATOR_UPDATE_CHECK = "1";
      assert.equal(updates.isManagedBinary(process.execPath), true);
      patchUpdateState((s) => ({ ...s, pending: { version: "0.28.37", fromVersion: "0.28.36", startedAt: manual.now() } }), dataDir);
      updates.setCliNoticeVersionForTests("0.28.37");
      if (mode === "advert-active") assert.equal(updates.isAutoUpdateActive(), false);
      if (mode === "advert-auto") assert.deepEqual(updates.getAutoUpdateAdvert(), {});
      if (mode === "advert-release") assert.deepEqual(updates.getUpdateAdvert(), {});
    } finally {
      Object.defineProperty(process, "execPath", execPath);
    }
    break;
  }
  case "hint": {
    const input = { current: manual.currentVersion, enabled: true, managed: true, now: manual.now(), dataDir };
    assert.equal(updates.takeCliUpdateHint(input), null);
    patchUpdateState(() => ({ releaseCheck: {
      attemptedAt: input.now, failedAt: input.now, failingSince: input.now - 4 * 60 * 60 * 1000, error: "test failure",
    } }), dataDir);
    assert.equal(updates.takeCliUpdateHint(input), null);
    break;
  }
  case "route": {
    const url = new URL("http://localhost:12345/api/update");
    const response = await updates.handleUpdateRoute(new Request(url, {
      method: "POST", headers: { host: url.host, "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: "policy-probe" }),
    }), url, { port: 12345, exposed: false, serverSession: "policy-probe" });
    assert.equal(response?.status, 409);
    assert.equal((await response!.json()).code, "update_disabled");
    break;
  }
  case "inbox": {
    const { createInboxUpdates } = await import("../../packages/server/inbox-updates");
    process.env.PLANNOTATOR_UPDATE_CHECK = "0";
    const inbox = createInboxUpdates({
      ...manual, version: manual.currentVersion, binaryPath: null, healthTickMs: 1000,
      fetchReleasePage: unexpected, fetchRelease: unexpected,
      launchInstaller: unexpected, listSessions: () => [], onChange: () => {},
    });
    try {
      assert.deepEqual(await inbox.updateNow(), { outcome: "disabled" });
      assert.deepEqual(await inbox.machineStart(), { outcome: "disabled" });
      const details = inbox.details();
      assert.equal(details.update, null);
      assert.equal(details.auto_update.supported, false);
      assert.equal(details.auto_update.on, false);
      assert.equal(details.command, "plannotator update");
    } finally {
      inbox.stop();
    }
    break;
  }
  case "inbox-ready": {
    const { createInboxUpdates } = await import("../../packages/server/inbox-updates");
    process.env.PLANNOTATOR_UPDATE_CHECK = "0";
    const binaryPath = join(dataDir, "replacement");
    writeFileSync(binaryPath, "replacement marker");
    let changed!: () => void;
    const change = new Promise<void>((resolve) => { changed = resolve; });
    const timer = setTimeout(changed, 5000);
    const inbox = createInboxUpdates({
      ...manual, version: manual.currentVersion, binaryPath, healthTickMs: 60_000,
      probeVersion: async () => "0.28.38", onChange: changed,
      fetchReleasePage: unexpected, fetchRelease: unexpected, fetchReleaseTag: unexpected,
    });
    try {
      inbox.start();
      await change;
      assert.equal(inbox.current()?.state, "ready");
      assert.equal(inbox.current()?.version, "0.28.38");
    } finally {
      clearTimeout(timer);
      inbox.stop();
    }
    break;
  }
  case "inbox-settings": {
    const { startInboxServer } = await import("../../packages/server/inbox");
    process.env.PLANNOTATOR_AUTO_UPDATE = "1";
    process.env.PLANNOTATOR_UPDATE_CHECK = "0";
    const inbox = await startInboxServer({
      dataDir, version: manual.currentVersion, binaryPath: null,
      updates: { fetchReleasePage: unexpected, fetchRelease: unexpected, launchInstaller: unexpected },
    });
    try {
      const settings = await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`)).json();
      assert.equal(settings.updates.auto_update.on, false);
    } finally {
      inbox.stop();
    }
    break;
  }
  default:
    throw new Error(`unknown probe: ${mode}`);
}
console.log(`guarded: ${mode}`);
