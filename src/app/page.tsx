import { redirect } from "next/navigation";

// The projects shell lives at /app (UI01), which gates sign-in itself.
export default function Home() {
  redirect("/app");
}
