import assert from "node:assert/strict";
import { Client } from "pg";
import { admissionSubject } from "../../../src/features/proposals/server/admit-run.ts";
import { withFixture, type Fixture, type Identity } from "./fixture.ts";

// The last-Admin guard counts every active Admin in the database, so staff tests must not overlap. Integration files run in parallel
// processes against one database; this advisory lock (held on the bootstrap connection for the whole run) makes them take turns.
const STAFF_TESTS_LOCK = 20261014;

export type Person = { identity: Identity; profile: string };
export type StaffEnv = Fixture & { web: Client; person: (label?: string) => Promise<Person>; staff: (who: Person, role: "ADMIN" | "MODERATOR") => Promise<void> };

/** A fixture plus a connection as the web runtime role, people with profiles, and a way to seed the first staff rows. */
export async function withStaff(run: (env: StaffEnv) => Promise<void>) {
  await withFixture(async (fixture) => {
    await fixture.database.query("select pg_advisory_lock($1)", [STAFF_TESTS_LOCK]);
    const web = new Client({ connectionString: process.env.DATABASE_URL! });
    await web.connect();
    const profiles: string[] = [];
    const person = async (label?: string): Promise<Person> => {
      const identity = await fixture.user(label);
      const profile = await fixture.profileId(identity);
      profiles.push(profile);
      return { identity, profile };
    };
    // The first Admin is granted by an operator script: seed the first staff rows on the bootstrap connection.
    const staff = async (who: Person, role: "ADMIN" | "MODERATOR") => {
      await fixture.database.query("insert into app.platform_role (profile_id, role, granted_by) values ($1, $2, $1)", [who.profile, role]);
    };
    try {
      const { rows: [existing] } = await fixture.database.query<{ n: number }>("select count(*)::int as n from app.platform_role where revoked_at is null");
      assert.equal(existing!.n, 0, "staff tests need a disposable database with no active staff");
      await run({ ...fixture, web, person, staff });
    } finally {
      await fixture.database.query("delete from app.rate_limit_bucket where subject_hash = any($1::text[])", [profiles.map((profile) => admissionSubject(profile))]);
      await web.end();
      await fixture.database.query("select pg_advisory_unlock($1)", [STAFF_TESTS_LOCK]);
    }
  });
}
