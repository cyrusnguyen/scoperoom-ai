import { previewReview } from "@/features/reviews/server/reviews";
import { REVIEW_BODY_LIMIT } from "@/features/reviews/contracts/review";
import { mutationRoute } from "@/server/web/api-request";
export const dynamic="force-dynamic";
export async function POST(request:Request,{params}:{params:Promise<{projectId:string;draftId:string}>}){
 const {projectId,draftId}=await params;
 return mutationRoute(request,(user,input)=>{return previewReview(user,projectId,draftId,input);},{bodyLimit:REVIEW_BODY_LIMIT,keyless:true,limitDetails:{limit:"REVIEW_BODY"}});
}
