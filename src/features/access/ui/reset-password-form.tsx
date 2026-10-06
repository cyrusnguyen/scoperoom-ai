"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import VerificationCodeInput from "./verification-code-input";
import VerificationTiming from "./verification-timing";

type RecoveryResult = { kind: "invalid-input" | "invalid-code" | "unavailable" | "new-code-required" | "update-unknown" | "updated" | "updated-with-signout-warning" } | { kind: "signed-in" };
type RequestResult = { kind: "invalid-input" | "signed-in" | "unavailable" | "send-unknown" | "accepted" } | { kind: "cooldown"; remainingSeconds: number };
type Props = {
  email: string | null;
  sentAt: number | null;
  status: string | null;
  error: string | null;
  continuation: string | null;
  recoverAction: (formData: FormData) => Promise<RecoveryResult>;
  requestAction: (formData: FormData) => Promise<RequestResult>;
  changeEmailAction: () => Promise<{ kind: "ready" }>;
};

export default function ResetPasswordForm({ email: initialEmail, sentAt, status, error: initialError, continuation, recoverAction, requestAction, changeEmailAction }: Props) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [remembered, setRemembered] = useState(Boolean(initialEmail));
  const [codeKey, setCodeKey] = useState(0);
  const [invalidCode, setInvalidCode] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [message, setMessage] = useState<string | null>(initialError === "unavailable" ? "Password reset is temporarily unavailable. Please try again later." : initialError === "cooldown" ? "A reset code was requested recently. Wait for the timer before requesting another code." : null);
  const [notice, setNotice] = useState(status === "send-unknown" ? "We could not confirm the request. Check your email before requesting another code." : status === "sent" ? "If an account exists for this email, we have sent a reset code." : null);
  const [pending, startTransition] = useTransition();
  const suffix = continuation ? `?continue=${encodeURIComponent(continuation)}` : "";

  function clearSecrets() {
    formRef.current?.reset();
    setCodeKey((current) => current + 1);
    setInvalidCode(false);
    setMismatch(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const data = new FormData(event.currentTarget);
    if (data.get("password") !== data.get("confirmation")) {
      setMismatch(true);
      document.getElementById("confirmation")?.focus();
      return;
    }
    setMismatch(false);
    setInvalidCode(false);
    startTransition(async () => {
      let result: RecoveryResult;
      try {
        result = await recoverAction(data);
      } catch {
        clearSecrets();
        setMessage("We could not confirm the password change. Try signing in with your new password, or request a new code.");
        return;
      }
      if (result.kind === "updated" || result.kind === "updated-with-signout-warning") {
        clearSecrets();
        router.replace(`/login?status=${result.kind === "updated" ? "password-reset" : "password-reset-warning"}${continuation ? `&continue=${encodeURIComponent(continuation)}` : ""}`);
      } else if (result.kind === "signed-in") {
        clearSecrets();
        router.refresh();
      } else if (result.kind === "invalid-code") {
        setInvalidCode(true);
        setMessage("The code is invalid or expired. Try again or request a new code.");
      } else if (result.kind === "new-code-required") {
        clearSecrets();
        setMessage("The code could not be completed. Request a new code before trying again.");
      } else if (result.kind === "update-unknown") {
        clearSecrets();
        setMessage("We could not confirm the password change. Try signing in with your new password, or request a new code.");
      } else if (result.kind === "unavailable") {
        clearSecrets();
        setMessage("Password reset is temporarily unavailable. A fresh code may be needed. Request a new code or try again later.");
      } else {
        setMessage("Enter a valid email, six-digit code, and matching password.");
      }
    });
  }

  function resend() {
    const form = formRef.current;
    if (!form) return;
    setMessage(null);
    const data = new FormData();
    data.set("email", email);
    if (continuation) data.set("continue", continuation);
    startTransition(async () => {
      let result: RequestResult;
      try { result = await requestAction(data); }
      catch {
        clearSecrets();
        setNotice("We could not confirm the request. Check your email before requesting another code.");
        return;
      }
      if (result.kind === "accepted" || result.kind === "send-unknown") {
        clearSecrets();
        setEmail(String(data.get("email") ?? "").trim().toLowerCase());
        setRemembered(true);
        setNotice(result.kind === "accepted" ? "If an account exists for this email, we have sent a reset code." : "We could not confirm the request. Check your email before requesting another code.");
        router.refresh();
      } else if (result.kind === "cooldown") {
        setNotice(`A reset code was requested recently. Wait ${result.remainingSeconds} seconds before requesting another code.`);
      } else if (result.kind === "signed-in") {
        router.refresh();
      } else if (result.kind === "unavailable") {
        setNotice("Password reset is temporarily unavailable. Please try again later.");
      } else {
        setNotice("Enter a valid email address.");
      }
    });
  }

  function changeEmail() {
    startTransition(async () => {
      try {
        await changeEmailAction();
        clearSecrets();
        router.push(`/forgot-password${suffix}`);
      } catch {
        setMessage("We could not change the recovery email. Please try again.");
      }
    });
  }

  return (
    <>
      {remembered && <div className="verification-recipient"><span>Reset email <strong>{email}</strong></span><button type="button" onClick={changeEmail} disabled={pending}>Change email</button></div>}
      <form ref={formRef} className="login-form" onSubmit={submit}>
        {continuation && <input type="hidden" name="continue" value={continuation} />}
        {remembered ? <input type="hidden" name="email" value={email} /> : <><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" required maxLength={320} value={email} onChange={(event) => setEmail(event.target.value)} /></>}
        <VerificationCodeInput key={codeKey} invalid={invalidCode} errorId={invalidCode && message ? "recovery-result" : undefined} />
        <label htmlFor="password">New password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} aria-invalid={mismatch || undefined} aria-describedby={mismatch ? "password-match-error" : undefined} />
        <label htmlFor="confirmation">Confirm new password</label>
        <input id="confirmation" name="confirmation" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} aria-invalid={mismatch || undefined} aria-describedby={mismatch ? "password-match-error" : undefined} />
        {mismatch && <p id="password-match-error" className="login-field-error" role="alert">New passwords do not match.</p>}
        {notice && <p className="login-notice" role="status">{notice}</p>}
        {message && <p id="recovery-result" className="login-error" role="alert">{message}</p>}
        <button type="submit" disabled={pending}>{pending ? "Resetting…" : "Reset password"}</button>
        <VerificationTiming sentAt={sentAt} onResend={resend} disabled={pending} />
      </form>
      <p className="login-footnote"><Link href={`/login${suffix}`}>Back to sign in</Link>{message && <> · <Link href={`/forgot-password${suffix}`}>Request a new code</Link></>}</p>
    </>
  );
}
