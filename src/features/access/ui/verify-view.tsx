import Link from "next/link";
import { changeVerificationEmail, resendVerificationCode, verifyEmailCode } from "@/features/access/server/actions";
import AuthCard from "./auth-card";
import VerificationCodeInput from "./verification-code-input";
import VerificationTiming from "./verification-timing";

type VerifyViewProps = {
  email: string;
  sentAt: number | null;
  message: string | null;
  isError: boolean;
};

export default function VerifyView({ email, sentAt, message, isError }: VerifyViewProps) {
  return (
    <AuthCard title="Verify your email" description="Enter a confirmation code to finish creating your account.">
      <div className="verification-recipient">
        <span>Account email <strong>{email}</strong></span>
        <form action={changeVerificationEmail}>
          <button type="submit">Change</button>
        </form>
      </div>
      <form action={verifyEmailCode} className="login-form">
        <VerificationCodeInput />
        {message && <p className={isError ? "login-error" : "login-notice"} role={isError ? "alert" : "status"}>{message}</p>}
        <button type="submit">Verify email</button>
        <VerificationTiming sentAt={sentAt} resendAction={resendVerificationCode} />
      </form>
      <p className="login-footnote"><Link href="/login">Back to sign in</Link></p>
    </AuthCard>
  );
}