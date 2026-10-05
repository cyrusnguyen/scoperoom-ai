import AuthCard from "./auth-card";
import ForgotPasswordForm from "./forgot-password-form";

type RequestResult = { kind: "invalid-input" | "signed-in" | "unavailable" | "send-unknown" | "accepted" } | { kind: "cooldown"; remainingSeconds: number };
type Props = { continuation: string | null; requestAction: (formData: FormData) => Promise<RequestResult> };

export default function ForgotPasswordView({ continuation, requestAction }: Props) {
  return (
    <AuthCard title="Forgot password?" description="Enter your email to reset your password.">
      <ForgotPasswordForm continuation={continuation} requestAction={requestAction} />
    </AuthCard>
  );
}
