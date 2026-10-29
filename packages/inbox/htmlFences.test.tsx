/** Message HTML stays code without registering or loading an embed document. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { resetEmbedGateForTests } from '@plannotator/ui/components/html-embed/loadGate';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');
const HTML = '<img src="https://sink.invalid/private"><script>location.href="https://sink.invalid/navigation"</script>';
const fence = ['```html', HTML, '```'].join('\n');
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let observer: PropertyDescriptor | undefined;
let requested: string[];

beforeEach(() => {
  if (!hasDom) return;
  resetEmbedGateForTests();
  savedFetch = globalThis.fetch;
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return Response.json({ code: 'html_embeds_disabled' }, { status: 403 });
  }) as typeof fetch;
  // Force the loader to run; an off-screen frame must not make this check pass.
  observer = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
});

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  if (observer) Object.defineProperty(globalThis, 'IntersectionObserver', observer);
  else delete (globalThis as Record<string, unknown>).IntersectionObserver;
});

async function mount(body: string, person = false): Promise<void> {
  const message = {
    id: 'msg_html_source', project_id: 'prj_html_source', thread_id: 'msg_html_source', reply_to: null,
    author: person ? { kind: 'person' } : { kind: 'agent', host: 'claude-code', session: 'fixture' },
    subject: 'HTML source', body, created_at: '2026-10-29T17:00:00Z', resolved_at: null,
    idempotency_key: null, questions: [], attachments: [],
  } as unknown as InboxMessageWire;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<MessageBody message={message} projectRoot="/fixture" onOpenAttachment={() => {}}
      readOnly={false} answers={new Map()} onPick={() => {}} footerFor={() => null} />);
  });
  await act(async () => { await new Promise((done) => setTimeout(done, 30)); });
}

for (const person of [false, true]) {
  test.skipIf(!hasDom)(`${person ? 'person' : 'agent'} message HTML is source with no embed request`, async () => {
    await mount(`Ordinary **Markdown**.\n\n${fence}`, person);
    expect(host!.querySelector('strong')?.textContent).toBe('Markdown');
    expect(host!.textContent).toContain(HTML);
    expect(host!.querySelector('iframe')).toBeNull();
    expect(host!.querySelector('img')).toBeNull();
    expect(requested).toEqual([]);
  });
}

test.skipIf(!hasDom)('a sent reply renders its feedback HTML as source too', async () => {
  const open = "You have 1 other question open in this thread. It stays open; the person will answer it in the Inbox. Don't re-ask it.";
  await mount(`Reply words.\n\n${open}\n\n${fence}`, true);
  expect(host!.querySelector('[data-sent-rest]')).not.toBeNull();
  expect(host!.querySelector('[data-sent-rest]')!.textContent).toContain(HTML);
  expect(host!.querySelector('iframe')).toBeNull();
  expect(requested).toEqual([]);
});

test.skipIf(!hasDom)('SVG fences still draw as images', async () => {
  await mount('```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n```');
  expect(host!.querySelector('img[src^="data:image/svg+xml"]')).not.toBeNull();
  expect(requested).toEqual([]);
});

test.skipIf(!hasDom)('every HTML fence shows source beyond the live-embed limit', async () => {
  const sources = Array.from({ length: 13 }, (_, i) => `<p>html-source-${i}</p>`);
  await mount(sources.map((html) => ['```html', html, '```'].join('\n')).join('\n\n'));
  for (const html of sources) expect(host!.textContent).toContain(html);
  expect(host!.querySelector('iframe')).toBeNull();
  expect(requested).toEqual([]);
});
