import { randomUUID } from "node:crypto";
import type { Client } from "pg";

/** Inserts a profile with no Auth user; schema tests never need sign-in. */
export async function insertProfile(database: Client, label = "Schema test") {
  const { rows: [row] } = await database.query<{ id: string }>("insert into app.user_profile (display_name) values ($1) returning id", [`${label} ${randomUUID().slice(0, 8)}`]);
  return row!.id;
}

/** Inserts a project with its editable current draft in one transaction, as the deferred trigger requires. */
export async function insertProject(database: Client, ownerId: string, name = "Schema project") {
  await database.query("begin");
  try {
    const { rows: [project] } = await database.query<{ id: string }>("insert into app.project (owner_id, name) values ($1, $2) returning id", [ownerId, name]);
    const { rows: [draft] } = await database.query<{ id: string }>("insert into app.scope_draft (project_id, created_by, document_json, layout_json) values ($1, $2, '{}'::jsonb, '{}'::jsonb) returning id", [project!.id, ownerId]);
    await database.query("update app.project set current_draft_id = $1 where id = $2", [draft!.id, project!.id]);
    await database.query("commit");
    return project!.id;
  } catch (error) {
    await database.query("rollback");
    throw error;
  }
}

export async function removeSchemaRows(database: Client, profileIds: string[]) {
  await database.query("delete from app.project where owner_id = any($1::uuid[])", [profileIds]);
  await database.query("delete from app.user_profile where id = any($1::uuid[])", [profileIds]);
}
