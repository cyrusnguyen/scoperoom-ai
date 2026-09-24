import Link from "next/link";
import { signUp } from "@/features/access/server/actions";
import AuthCard from "./auth-card";

export default function SignupView({ message }: { message: string | null }) {
  return (
    <AuthCard title="Create your account" description="Enter your name and email, then verify your address with a code.">
      <form action={signUp} className="login-form">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" type="text" autoComplete="name" required maxLength={80} />
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={320} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} />
        <label htmlFor="confirm-password">Confirm password</label>
        <input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} />
        {message && <p className="login-error" role="alert">{message}</p>}
        <button type="submit">Create account</button>
      </form>
      <p className="login-footnote">Already have an account? <Link href="/login">Sign in</Link></p>
    </AuthCard>
  );
}
