import { uuid, type ProjectIdentity } from "../../projects/contracts/project.ts";
import { profileFor, readProject, requireMember, withDatabase, withReadSnapshot } from "../../projects/server/access.ts";
import { ProjectError } from "../../projects/server/errors.ts";
import { signRealtimeToken } from "./sign-token.ts";

/**
 * Mints the scoped Realtime credential for the caller and the project's current epoch. Identity comes from the verified session and
 * the epoch from SQL: nothing about the scope is taken from the browser. Read access is the same as the status read, so anyone
 * who cannot read the project gets the non-disclosing NOT_FOUND. Nothing is persisted or audited.
 */
export async function issueRealtimeToken(identity: ProjectIdentity, projectId: string, options: { env?: Record<string, string | undefined>; now?: number } = {}) {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  const scope = await withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      requireMember(project);
      return { profileId: profile.id, projectId: project.id, epoch: project.realtimeEpoch };
    });
  });
  const signed = signRealtimeToken(scope, options);
  if (!signed.ok) throw new ProjectError("UNAVAILABLE");
  return { accessToken: signed.token, expiresAt: signed.expiresAt };
}
