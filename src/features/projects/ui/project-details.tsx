"use client";

import type { ProjectBootstrap } from "../contracts/project";
import { roleLabel } from "./format";
import ProjectManagement from "./project-management";
import ProjectShare from "./project-share";

/** The right panel's Details tab. Task 5 replaces the two existing disclosures below with flat Details sections. */
export default function ProjectDetails({ bootstrap, onChanged }: { bootstrap: ProjectBootstrap; onChanged: () => void }) {
  const { project, draft } = bootstrap;
  return <>
    <section className="detail-section" aria-labelledby="details-title">
      <h3 id="details-title">{project.name}</h3>
      <dl className="detail-facts">
        <div><dt>Your role</dt><dd>{roleLabel(project.role)}</dd></div>
        <div><dt>Status</dt><dd>{project.status === "ARCHIVED" ? "Archived" : "Active"}</dd></div>
        <div><dt>Draft</dt><dd>Empty draft · revision {draft.documentRevision}</dd></div>
      </dl>
    </section>
    {project.status === "ACTIVE" && <ProjectShare projectId={project.id} role={project.role} />}
    <ProjectManagement projectId={project.id} role={project.role} projectName={project.name} projectStatus={project.status} onProjectChange={onChanged} />
  </>;
}
