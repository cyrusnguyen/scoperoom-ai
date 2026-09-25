"use client";

import { useEffect, useState } from "react";
import { CODE_VALIDITY_SECONDS, RESEND_COOLDOWN_SECONDS, secondsRemaining } from "@/features/access/verification-policy";

type Props = {
  sentAt: number | null;
  resendAction: (formData: FormData) => Promise<void>;
};

function minutesAndSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function VerificationTiming({ sentAt, resendAction }: Props) {
  const [now, setNow] = useState(sentAt ?? 0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const expiresIn = secondsRemaining(sentAt, CODE_VALIDITY_SECONDS, now);
  const resendIn = secondsRemaining(sentAt, RESEND_COOLDOWN_SECONDS, now);
  const hint = sentAt === null ? "Codes expire 10 minutes after sending." :
    expiresIn > 0 ? `Code expires in ${minutesAndSeconds(expiresIn)}.` :
    "This code has expired. Request a new one.";

  return (
    <>
      <p className="verification-timing">{hint}</p>
      <button type="submit" formAction={resendAction} formNoValidate disabled={resendIn > 0} className="login-secondary-button">
        {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
      </button>
    </>
  );
}