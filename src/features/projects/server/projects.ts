import { Prisma } from "../../../../prisma/generated/client.ts";
import { realtimeTopics } from "../../collaboration/contracts/topics.ts";
import { emptyDraft, parseDraftPair } from "../../drafts/contracts/scope-document.ts";
import {
  PROJECT_LIST_LIMIT, type CreatedProject, type CreateProjectInput, type ProjectAccessRole, type ProjectBootstrap, type ProjectGroup,
  type ProjectIdentity, type ProjectListItem, type ProjectLists, type ProjectStatusView, uuid, validateProjectCreateInput,
} from "../contracts/project.ts";
import {
  assertOwnerCapacity, checkReceipt, entitlementActive, findReceipt, lockActor, lockOwnerCapacity, profileFor, readProject,
  receiptString, requestHash, requireMember, requireOwner, saveReceipt, withDatabase, withReadSnapshot, type ProjectRow,
} from "./access.ts";
import { settleOverdueRuns } from "../../proposals/server/settle-runs.ts";
import { ProjectError } from "./errors.ts";

const CREATE_OPERATION = "CREATE_PROJECT_V2";

export async function createProject(identity: ProjectIdentity, input: unknown): Promise<CreatedProject> {
  let validated: CreateProjectInput;
  try { validated = validateProjectCreateInput(input); } catch { throw new ProjectError("INVALID_INPUT"); }
  const hash = requestHash(CREATE_OPERATION, { name: validated.name });
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return database.$transaction(async (tx) => {
      await lockActor(tx, profile.id, identity.authUserId);
      await lockOwnerCapacity(tx, profile.id);
      const receipt = await findReceipt(tx, profile.id, "USER", profile.id, validated.key);
      if (receipt) {
        checkReceipt(receipt, CREATE_OPERATION, hash);
        const id = receiptString(receipt.result, "id");
        if (!id) throw new ProjectError("UNAVAILABLE");
        const project = await readProject(tx, profile.id, id);
        requireOwner(project);
        return { id: project.id, name: project.name, replayed: true };
      }
      await assertOwnerCapacity(tx, profile.id);
      const project = await tx.project.create({ data: { ownerId: profile.id, name: validated.name, eventSequence: BigInt(1) }, select: { id: true, name: true } });
      const empty = emptyDraft();
      const draft = await tx.scopeDraft.create({ data: { projectId: project.id, createdBy: profile.id, documentJson: empty.document, layoutJson: empty.layout }, select: { id: true } });
      await tx.project.update({ where: { id: project.id }, data: { currentDraftId: draft.id } });
      await tx.auditEvent.create({ data: { projectId: project.id, sequence: BigInt(1), actorId: profile.id, action: "PROJECT_CREATED", entityRefs: [{ kind: "PROJECT", id: project.id }], metadata: {} } });
      await saveReceipt(tx, profile.id, "USER", profile.id, validated.key, CREATE_OPERATION, hash, { id: project.id, name: project.name });
      return { ...project, replayed: false };
    });
  });
}

type RawListRow = { id: string; name: string; status: string; updated_at: Date; owner_name: string; role: string };

function toListItem(row: RawListRow): ProjectListItem {
  return { id: row.id, name: row.name, status: row.status as "ACTIVE" | "ARCHIVED", role: row.role as ProjectAccessRole, ownerName: row.owner_name, updatedAt: row.updated_at.toISOString() };
}

export async function listProjects(identity: ProjectIdentity): Promise<ProjectLists> {
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const group = async (filter: Prisma.Sql): Promise<ProjectGroup> => {
        const rows = await tx.$queryRaw<RawListRow[]>`
          SELECT project.id, project.name, project.status::text AS status, project.updated_at, owner.display_name AS owner_name,
            CASE WHEN project.owner_id = ${profile.id}::uuid THEN 'OWNER' ELSE membership.role::text END AS role
          FROM app.project project
          JOIN app.user_profile owner ON owner.id = project.owner_id
          LEFT JOIN app.project_membership membership
            ON membership.project_id = project.id AND membership.profile_id = ${profile.id}::uuid AND membership.active
          WHERE (project.owner_id = ${profile.id}::uuid OR membership.profile_id IS NOT NULL) AND ${filter}
          ORDER BY project.updated_at DESC, project.id DESC
          LIMIT ${PROJECT_LIST_LIMIT + 1}`;
        return { items: rows.slice(0, PROJECT_LIST_LIMIT).map(toListItem), truncated: rows.length > PROJECT_LIST_LIMIT };
      };
      const owned = await group(Prisma.sql`project.owner_id = ${profile.id}::uuid AND project.status = 'ACTIVE'::app.project_status`);
      const shared = await group(Prisma.sql`project.owner_id <> ${profile.id}::uuid AND project.status = 'ACTIVE'::app.project_status`);
      const archived = await group(Prisma.sql`project.status = 'ARCHIVED'::app.project_status`);
      const entitlement = await tx.pilotEntitlement.findUnique({ where: { profileId: profile.id } });
      const activeOwned = await tx.project.count({ where: { ownerId: profile.id, status: "ACTIVE" } });
      const entitled = Boolean(entitlement && entitlementActive(entitlement));
      const maxOwned = entitled ? entitlement!.maxOwnedProjects : 0;
      return { owned, shared, archived, capacity: { entitled, activeOwned, maxOwned, canCreate: entitled && activeOwned < maxOwned } };
    });
  });
}

type DraftCounters = { documentRevision: number; layoutRevision: number };

// One mapping for both reads, so bootstrap's status and topics come from the same snapshot as its draft.
function statusOf(project: ProjectRow, draft: DraftCounters & { id: string }, role: ProjectAccessRole, viewerId: string): ProjectStatusView {
  return {
    viewerId, status: project.status, role, version: project.version, settingsVersion: project.settingsVersion, approvalPolicyVersion: project.approvalPolicyVersion,
    membershipVersion: project.membershipVersion, designatedApproverId: project.designatedApproverId, currentDraftId: draft.id,
    documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, realtimeEpoch: project.realtimeEpoch, eventSequence: Number(project.eventSequence),
    aiRevision: project.aiRevision, sourcesRevision: project.sourcesRevision, approvedSnapshotId: project.approvedSnapshotId,
  };
}

export async function getProjectBootstrap(identity: ProjectIdentity, projectId: string): Promise<ProjectBootstrap> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    await settleOverdueRuns(database, profile.id, projectId); // a bounded authorized write, before and never inside the READ ONLY snapshot
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const draft = project.currentDraftId ? await tx.scopeDraft.findFirst({ where: { id: project.currentDraftId, projectId: project.id, status: "EDITABLE" } }) : null;
      if (!draft) throw new ProjectError("NOT_FOUND");
      let saved: ReturnType<typeof parseDraftPair>;
      try {
        saved = parseDraftPair(draft.documentJson, draft.layoutJson);
      } catch {
        throw new ProjectError("UNAVAILABLE");
      }
      const status = statusOf(project, draft, role, profile.id);
      return {
        project: { id: project.id, name: project.name, status: project.status, role, ownerId: project.ownerId },
        draft: { id: draft.id, status: draft.status, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, ...saved },
        status,
        realtime: realtimeTopics(project.id, status.realtimeEpoch),
      };
    });
  });
}

export async function getProjectStatus(identity: ProjectIdentity, projectId: string): Promise<ProjectStatusView> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    await settleOverdueRuns(database, profile.id, projectId);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const draft = project.currentDraftId ? await tx.scopeDraft.findFirst({ where: { id: project.currentDraftId, projectId: project.id }, select: { id: true, documentRevision: true, layoutRevision: true } }) : null;
      if (!draft) throw new ProjectError("NOT_FOUND");
      return statusOf(project, draft, role, profile.id);
    });
  });
}
