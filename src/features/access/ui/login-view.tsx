import Link from "next/link";
import { signIn } from "@/features/access/server/actions";
import AuthCard from "./auth-card";

export default function LoginView({ message, isError, continuation }: { message: string | null; isError: boolean; continuation: string | null }) {
  return (
    <AuthCard title="Sign in to ScopeRoom" description="Open your canvas with your verified account.">
      <form action={signIn} className="login-form">
        {continuation && <input type="hidden" name="continue" value={continuation} />}
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="username" required maxLength={320} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
        {message && <p className={isError ? "login-error" : "login-notice"} role={isError ? "alert" : "status"}>{message}</p>}
        <button type="submit">Sign in</button>
      </form>
      <p className="login-footnote">New here? <Link href={continuation ? `/signup?continue=${encodeURIComponent(continuation)}` : "/signup"}>Create an account</Link></p>
    </AuthCard>
  );
}