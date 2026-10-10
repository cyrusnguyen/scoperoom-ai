import { readReview } from "@/features/reviews/server/read-reviews";
import { readRoute } from "@/server/web/api-request";
export const dynamic="force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{projectId:string;reviewId:string}>}){const {projectId,reviewId}=await params;return readRoute(request,user=>readReview(user,projectId,reviewId));}
