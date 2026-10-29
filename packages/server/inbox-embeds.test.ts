/** HTML embed routes refuse content locally and over the tailnet. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxEmbeds } from "./inbox-embeds";

type Json = Record<string, any>;

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function start(extra: Partial<Parameters<typeof startInboxServer>[0]> = {}, config?: Json) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-embeds-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config) {
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000, ...extra });
  servers.push(server);
  return server;
}

const at = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const keep = (server: InboxServer, html: unknown, headers: Record<string, string> = {}) =>
  fetch(at(server, "/api/inbox/embeds"), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ html }) });


const PAGE = '<script>fetch("https://sink.invalid/private");location.href="https://sink.invalid/navigation"</script>';

describe("disabled Inbox embed documents", () => {
  test("registration refuses content and a direct document read never serves HTML", async () => {
    const server = await start();
    const response = await keep(server, PAGE);
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("html_embeds_disabled");

    for (const method of ["GET", "HEAD"]) {
      const page = await fetch(at(server, `/api/inbox/embeds/${"a".repeat(32)}`), { method });
      expect(page.status).toBe(403);
      expect(page.headers.get("content-type")).toContain("application/json");
      expect(await page.text()).not.toContain(PAGE);
    }
    expect((await fetch(at(server, "/api/inbox/health"))).status).toBe(200);
  });

  test("disabled paths refuse every method and do not parse the request body", async () => {
    const embeds = createInboxEmbeds({ json: (body, status = 200) => Response.json(body, { status }) });
    for (const path of ["/api/inbox/embeds", `/api/inbox/embeds/${"b".repeat(32)}`, "/api/inbox/embeds/nested/page"]) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
        const req = new Request(`http://127.0.0.1${path}`, {
          method, ...(method === "POST" || method === "PUT" ? { body: "not JSON" } : {}),
        });
        const response = await embeds.route(req, new URL(req.url));
        expect(response?.status).toBe(403);
        expect((await response!.json()).code).toBe("html_embeds_disabled");
        expect(req.bodyUsed).toBe(false);
      }
    }
    const other = new Request("http://127.0.0.1/api/inbox/embeds-other");
    expect(await embeds.route(other, new URL(other.url))).toBeNull();
  });

  test("cross-origin registration remains refused by the window guard", async () => {
    const server = await start();
    for (const headers of [{ Origin: "https://other.invalid" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
      expect((await keep(server, PAGE, headers)).status).toBe(403);
    }
  });

  test("over the tailnet embed registration and document reads are refused", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
    const serve = new Map<number, string>();
    const run: TailscaleRunner = (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
      if (args[1] === "status") {
        if (serve.size === 0) return ok("{}");
        return ok(
          JSON.stringify({
            TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
            Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
          }),
        );
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) serve.delete(httpsPort);
      else serve.set(httpsPort, args.at(-1)!);
      return ok(`https://${MAGIC}:${httpsPort}/\n`);
    };
    const server = await start({ phones: false, tailscale: run }, { inboxTailscale: true });
    const listener = server.tailscale.listenerPort()!;
    const origin = `https://${MAGIC}:${server.port}`;
    const through = (path: string, init: RequestInit & { headers: Record<string, string> }) =>
      fetch(`http://127.0.0.1:${listener}${path}`, { ...init, headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, ...init.headers } });

    // A same-origin window cannot register or read executable message content.
    const kept = await through("/api/inbox/embeds", {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ html: PAGE }),
    });
    expect(kept.status).toBe(403);
    expect((await kept.json()).code).toBe("html_embeds_disabled");
    const url = `/api/inbox/embeds/${"a".repeat(32)}`;
    const framed = await through(url, { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" } });
    expect(framed.status).toBe(403);
    expect((await framed.json()).code).toBe("html_embeds_disabled");

    // The page's own requests come from an opaque origin: the browser marks them cross-site.
    for (const path of [url, "/api/inbox/threads", "/api/inbox/health"]) {
      const answer = await through(path, { headers: { Origin: "null", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" } });
      expect(answer.status).toBe(403);
      expect(((await answer.json()) as Json).code).toBe("cross_site");
    }
  });
});
