/** Refuse live HTML documents; message fences display as source code. */
export const INBOX_EMBEDS_PATH = "/api/inbox/embeds";

export function createInboxEmbeds(options: {
  json: (body: unknown, status?: number) => Response;
}) {
  const route = async (_req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== INBOX_EMBEDS_PATH && !url.pathname.startsWith(`${INBOX_EMBEDS_PATH}/`)) return null;
    return options.json({
      error: "Live HTML embeds are disabled. HTML fences are displayed as code.",
      code: "html_embeds_disabled",
    }, 403);
  };
  return { route };
}
