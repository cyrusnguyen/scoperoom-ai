"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

type RequestResult =
  | { kind: "invalid-input" | "signed-in" | "unavailable" | "send-unknown" | "accepted" }
  | { kind: "cooldown"; remainingSeconds: number };
type Props = { continuation: string | null; requestAction: (formData: FormData) => Promise<RequestResult> };

export default function ForgotPasswordForm({ continuation, requestAction }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const suffix = continuation ? `?continue=${encodeURIComponent(continuation)}` : "";
  const resetPath = (status: string) => `/forgot-password/reset?status=${status}${continuation ? `&continue=${encodeURIComponent(continuation)}` : ""}`;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      let result: RequestResult;
      try {
        result = await requestAction(data);
      } catch {
        router.push(resetPath("send-unknown"));
        return;
      }
      if (result.kind === "accepted" || result.kind === "send-unknown") {
        router.push(resetPath(result.kind === "accepted" ? "sent" : "send-unknown"));
      } else if (result.kind === "cooldown") {
        setError(`A reset code was requested recently. Wait ${result.remainingSeconds} seconds before trying again.`);
      } else if (result.kind === "signed-in") {
        router.refresh();
      } else if (result.kind === "unavailable") {
        setError("Password reset is temporarily unavailable. Please try again later.");
      } else {
        setError("Enter a valid email address.");
      }
    });
  }

  return (
    <>
      <form className="login-form" onSubmit={submit}>
        {continuation && <input type="hidden" name="continue" value={continuation} />}
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "recovery-request-error" : undefined} />
        {error && <p id="recovery-request-error" className="login-error" role="alert">{error}</p>}
        <button type="submit" disabled={pending}>{pending ? "Sending…" : "Send reset code"}</button>
      </form>
      <p className="login-footnote"><Link href={`/login${suffix}`}>Back to sign in</Link></p>
    </>
  );
}
