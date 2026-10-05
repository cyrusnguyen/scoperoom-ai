import Link from "next/link";
import { signOut } from "@/features/access/server/actions";
import AuthCard from "./auth-card";

export default function RecoverySignedInView({ continuation }: { continuation: string | null }) {
  return (
    <AuthCard title="You are already signed in" description="Password recovery is available after you sign out of this account.">
      <div className="login-form">
        <Link className="login-primary-link" href="/app">Return to app</Link>
        <form action={signOut}>{continuation && <input type="hidden" name="continue" value={continuation} />}<button className="login-secondary-button" type="submit">Sign out</button></form>
      </div>
    </AuthCard>
  );
}
