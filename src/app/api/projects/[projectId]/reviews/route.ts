import { listReviews } from "@/features/reviews/server/read-reviews";
import { readRoute } from "@/server/web/api-request";
import { ProjectError } from "@/features/projects/server/errors";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{projectId:string}>}){
 const {projectId}=await params;return readRoute(request,user=>{const query=new URL(request.url).searchParams;if([...query.keys()].some(key=>key!=="cursor"&&key!=="state") || query.getAll("cursor").length>1 || query.getAll("state").length>1) throw new ProjectError("INVALID_INPUT");return listReviews(user,projectId,{cursor:query.get("cursor")??undefined,state:query.get("state")??undefined});});
}
