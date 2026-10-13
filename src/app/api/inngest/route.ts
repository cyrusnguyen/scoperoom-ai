import { serve } from "inngest/next";
import { inngest, runAiFunction } from "@/worker/functions";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // one step is one runAi call: at most two 120 s model attempts, inside the 300 s run deadline
export const { GET, POST, PUT } = serve({ client: inngest, functions: [runAiFunction] });
