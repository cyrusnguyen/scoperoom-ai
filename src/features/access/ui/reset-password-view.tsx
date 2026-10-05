import AuthCard from "./auth-card";
import ResetPasswordForm from "./reset-password-form";

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

export default function ResetPasswordView(props: Props) {
  return (
    <AuthCard title="Reset your password" description="Enter the reset code and choose a new password.">
      <ResetPasswordForm {...props} />
    </AuthCard>
  );
}
