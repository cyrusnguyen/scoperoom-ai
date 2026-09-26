import { Prisma } from "../../../../prisma/generated/client.ts";
import {
  PROJECT_LIST_LIMIT, type CreatedProject, type CreateProjectInput, type ProjectAccessRole, type ProjectBootstrap, type ProjectGroup,
  type ProjectIdentity, type ProjectListItem, type ProjectLists, type ProjectStatusView, uuid, validateProjectCreateInput,
} from "../contracts/project.ts";
import {
  assertOwnerCapacity, checkReceipt, entitlementActive, findReceipt, lockActor, lockOwnerCapacity, profileFor, readProject,
  receiptString, requestHash, requireMember, requireOwner, saveReceipt, withDatabase, withReadSnapshot,
} from "./access.ts";
import { ProjectError } from "./errors.ts";

const CREATE_OPERATION = "CREATE_PROJECT_V2";

const emptyDocument = {
  schemaVersion: 3, projectGoal: "",
  flows: {}, nodes: {}, edges: {}, requirements: {}, traceLinks: {},
  scenarios: {}, questions: {}, decisions: {}, dependencies: {}, waivers: {},
  retiredEntityIds: [],
} as const;
const emptyLayout = { schemaVersion: 1, positions: {}, directions: {} } as const;

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
      const draft = await tx.scopeDraft.create({ data: { projectId: project.id, createdBy: profile.id, documentJson: emptyDocument, layoutJson: emptyLayout }, select: { id: true } });
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

export async function getProjectBootstrap(identity: ProjectIdentity, projectId: string): Promise<ProjectBootstrap> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      const role = requireMember(project);
      const draft = project.currentDraftId ? await tx.scopeDraft.findFirst({ where: { id: project.currentDraftId, projectId: project.id, status: "EDITABLE" } }) : null;
      if (!draft) throw new ProjectError("NOT_FOUND");
      return {
        project: { id: project.id, name: project.name, status: project.status, role, ownerId: project.ownerId },
        draft: { id: draft.id, schemaVersion: 3, documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, documentJson: draft.documentJson, layoutJson: draft.layoutJson },
      };
    });
  });
}

export async function getProjectStatus(identity: ProjectIdentity, projectId: string): Promise<ProjectStatusView> {
  if (!uuid.test(projectId)) throw new ProjectError("NOT_FOUND");
  return withDatabase(async (database) => {
    const profile = await profileFor(database, identity);
    return withReadSnapshot(database, async (tx) => {
      const project = await readProject(tx, profile.id, projectId);
      requireMember(project);
      const draft = project.currentDraftId ? await tx.scopeDraft.findFirst({ where: { id: project.currentDraftId, projectId: project.id }, select: { documentRevision: true, layoutRevision: true } }) : null;
      if (!draft || !project.currentDraftId) throw new ProjectError("NOT_FOUND");
      return {
        status: project.status, version: project.version, settingsVersion: project.settingsVersion, approvalPolicyVersion: project.approvalPolicyVersion,
        membershipVersion: project.membershipVersion, designatedApproverId: project.designatedApproverId, currentDraftId: project.currentDraftId,
        documentRevision: draft.documentRevision, layoutRevision: draft.layoutRevision, realtimeEpoch: project.realtimeEpoch, eventSequence: Number(project.eventSequence),
      };
    });
  });
}
