import { createProject, listProjects } from "@/features/projects/server/projects";
import { mutationRoute, readRoute } from "@/server/web/api-request";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return readRoute(request, listProjects);
}

export function POST(request: Request) {
  return mutationRoute(request, createProject, { createdStatus: 201 });
}
