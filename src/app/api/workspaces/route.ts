import { WorkspaceError, createWorkspace, getWorkspaceHome } from "@/features/workspaces/server/workspaces";
import { authConfig } from "@/server/web/auth-config";
import { readProcessEnv } from "@/server/env";
import { createAuthClient } from "@/server/web/supabase";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store" };

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: noStore });
}

function safeError(code: string, message: string, status: number) {
  return response({ error: { code, message } }, status);
}

function displayName(value: unknown) {
  if (typeof value !== "string") return "there";
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= 80 ? name : "there";
}

async function identity() {
  if (!authConfig()) return null;
  const supabase = await createAuthClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !user.email_confirmed_at || user.is_anonymous) return null;
  return { authUserId: user.id, displayName: displayName(user.user_metadata.full_name) };
}

function workspaceError(error: unknown) {
  if (!(error instanceof WorkspaceError)) return safeError("UNAVAILABLE", "Workspace access is unavailable.", 503);
  const errors = {
    NOT_ENTITLED: ["NOT_ENTITLED", "Workspace creation is not available for this account.", 403],
    LIMIT_REACHED: ["LIMIT_REACHED", "Your workspace limit has been reached.", 409],
    KEY_REUSED: ["KEY_REUSED", "This create request conflicts with an earlier request.", 409],
    INVALID_INPUT: ["INVALID_INPUT", "Enter a valid workspace name and try again.", 400],
    UNAVAILABLE: ["UNAVAILABLE", "Workspace access is unavailable.", 503],
  } as const;
  const [code, message, status] = errors[error.code];
  return safeError(code, message, status);
}

async function boundedBody(request: Request) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 4_096)) return null;
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4_096) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

export async function GET() {
  const user = await identity();
  if (!user) return authConfig()
    ? safeError("UNAUTHENTICATED", "Sign in to continue.", 401)
    : safeError("UNAVAILABLE", "Workspace access is unavailable.", 503);

  try {
    return response(await getWorkspaceHome(user));
  } catch (error) {
    return workspaceError(error);
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== readProcessEnv().appUrl) {
    return safeError("INVALID_REQUEST", "This request could not be accepted.", 403);
  }

  const user = await identity();
  if (!user) return authConfig()
    ? safeError("UNAUTHENTICATED", "Sign in to continue.", 401)
    : safeError("UNAVAILABLE", "Workspace access is unavailable.", 503);

  const body = await boundedBody(request);
  const key = request.headers.get("idempotency-key");
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof (body as { name?: unknown }).name !== "string" || typeof key !== "string" || !/^[\x21-\x7e]{1,128}$/.test(key)) {
    return safeError("INVALID_INPUT", "Enter a valid workspace name and try again.", 400);
  }

  try {
    const created = await createWorkspace(user, { name: (body as { name: string }).name, key });
    return response(created, created.replayed ? 200 : 201);
  } catch (error) {
    return workspaceError(error);
  }
}

