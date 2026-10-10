import { exportApprovedMarkdown } from "@/features/exports/server/approved-markdown";
import { ProjectError } from "@/features/projects/server/errors";
import { readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; snapshotId: string }> }) {
  const { projectId, snapshotId } = await params;
  return readRoute(request, async user => {
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== "format") || query.getAll("format").length !== 1 || query.get("format") !== "markdown") throw new ProjectError("INVALID_INPUT");
    const { filename, text } = await exportApprovedMarkdown(user, projectId, snapshotId);
    // RFC 5987 attr-char excludes apostrophes and parentheses left intact by encodeURIComponent.
    const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(text, { headers: {
      "Content-Type": "text/markdown; charset=utf-8", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="approved-scope.md"; filename*=UTF-8''${encoded}`,
    } });
  });
}
