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
