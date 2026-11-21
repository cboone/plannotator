import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let scratch: string;
let entry: string;
beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "plannotator-update-policy-"));
  const built = await Bun.build({
    entrypoints: [resolve("tests/helpers/update-policy-probe.ts")],
    target: "bun", outdir: scratch,
    define: { __PLANNOTATOR_DISABLE_INSTALLER_UPDATES__: "true" },
    external: ["bun:test"],
  });
  expect(built.success).toBe(true);
  entry = built.outputs[0]!.path;
});
afterAll(() => rmSync(scratch, { recursive: true }));

function fixtureEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, "AppData", "Local"),
    APPDATA: join(root, "AppData", "Roaming"),
    PLANNOTATOR_DATA_DIR: join(root, "data"),
    PLANNOTATOR_POLICY_FIXTURE_ROOT: root,
  };
}

for (const mode of ["automatic", "manual", "detached", "foreground", "prepare", "prepare-command", "cli", "cli-check", "advert-active", "advert-auto", "advert-release", "hint", "route", "inbox", "inbox-ready", "inbox-settings"]) {
  test(`compiled installer prohibition: ${mode}`, async () => {
    const dataDir = mkdtempSync(join(scratch, `${mode}-`));
    const child = Bun.spawn([process.execPath, entry, mode], {
      env: fixtureEnv(dataDir),
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).toContain(`guarded: ${mode}`);
  }, 10_000);
}

test("advert fixture refuses application data outside its owned root before writing", async () => {
  const root = mkdtempSync(join(scratch, "confinement-"));
  const outside = join(scratch, "outside-fixture");
  const child = Bun.spawn([process.execPath, entry, "advert-active"], {
    env: { ...fixtureEnv(root), LOCALAPPDATA: outside }, stdout: "pipe", stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(err).toContain("LOCALAPPDATA escaped fixture");
  expect(existsSync(join(root, "data"))).toBe(false);
  expect(existsSync(outside)).toBe(false);
});

test("the probe refuses a data directory belonging to its simulated home", async () => {
  const root = mkdtempSync(join(scratch, "real-data-guard-"));
  const dataDir = join(root, ".plannotator");
  const child = Bun.spawn([process.execPath, entry, "manual"], {
    env: { ...fixtureEnv(root), PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_DATA_DIR: dataDir },
    stdout: "pipe", stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(err).toContain("refusing");
  expect(existsSync(dataDir)).toBe(false);
});

test("release smoke requires refusal before contacting its mirror", async () => {
  const child = Bun.spawn([process.execPath, "scripts/smoke-update-policy.mjs", process.execPath, entry], {
    env: fixtureEnv(mkdtempSync(join(scratch, "smoke-"))),
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain("without network requests");
}, 15_000);

test("release smoke detects a build without the installer prohibition", async () => {
  const built = await Bun.build({
    entrypoints: [resolve("tests/helpers/update-policy-probe.ts")],
    target: "bun", outdir: join(scratch, "unrestricted"),
    define: { __PLANNOTATOR_DISABLE_INSTALLER_UPDATES__: "false" },
    external: ["bun:test"],
  });
  expect(built.success).toBe(true);
  const child = Bun.spawn([process.execPath, "scripts/smoke-update-policy.mjs", process.execPath, built.outputs[0]!.path], {
    env: fixtureEnv(mkdtempSync(join(scratch, "negative-smoke-"))),
    stdout: "pipe", stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(err).toContain("update exited");
}, 15_000);
