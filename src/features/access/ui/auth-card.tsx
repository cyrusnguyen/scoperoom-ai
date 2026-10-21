import type { ReactNode } from "react";
import "./login.css";

type AuthCardProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export default function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="auth-title">
        <div className="login-brand">
          <span className="login-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
          <span>ScopeRoom <span className="login-brand-suffix">/ Studio</span></span>
        </div>
        <p className="login-kicker">SCOPEROOM</p>
        <h1 id="auth-title">{title}</h1>
        <p className="login-description">{description}</p>
        {children}
      </section>
    </main>
  );
}

/** Access could not be confirmed (an Auth or database outage): never read as signed out or as allowed. */
export function UnavailableCard() {
  return <AuthCard title="ScopeRoom is temporarily unavailable" description="We could not confirm your access. Try again when the service is available.">
    <form method="get" className="login-form"><button type="submit">Retry</button></form>
  </AuthCard>;
}
