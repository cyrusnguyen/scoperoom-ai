# Supabase email signup setup

ScopeRoom uses Supabase Auth for accounts, email confirmation, and sessions. Supabase stores identities in its managed PostgreSQL `auth` schema; the application Prisma migration does not create those tables. Signed-in sessions use Supabase SSR cookies. The separate one-hour HttpOnly `scoperoom.pending-email` and `scoperoom.code-sent-at` cookies remember the address and code timing on `/signup/verify`. Neither grants workspace access.

## Local project

1. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `NEXT_PUBLIC_APP_URL=http://127.0.0.1:3100` in the ignored `.env.local`. Get the first two values from `pnpm exec supabase status --output json`. Never put a secret or service-role key in a `NEXT_PUBLIC_` variable.
2. Restart the local Supabase stack after changing `supabase/config.toml`. The confirmation template at `supabase/templates/confirmation.html` sends `{{ .Token }}`. Mailpit, shown by `supabase status`, captures the message.
3. Run `pnpm dev` and open `http://127.0.0.1:3100/signup`. The dev command uses the same origin as `NEXT_PUBLIC_APP_URL`. Browser tests run separately on port 3101 with local Supabase and Mailpit. Sign up and enter the delivered code at `/signup/verify`. Only a confirmed account can sign in and reach `/`.

The app on port 3100 reads the Supabase URL and key in `.env.local`. Check whether those point to local (`127.0.0.1:54321`) or hosted Auth before testing an existing account. The two projects have separate users even when the email address is the same. Local confirmation mail stays in Mailpit; it does not reach Gmail. On Windows, browser tests require the isolated port-3101 Next server running with `SCOPEROOM_E2E=1` and local Supabase public variables.

Signup requires a name. Supabase saves its normalized value in `auth.users.raw_user_meta_data.full_name`. Existing users are not renamed. This metadata is suitable for display, not authorization.

## Hosted project

The checked-in local email template and `config.toml` do **not** update a hosted Supabase project. On 2026-09-24, the hosted project was configured through the Supabase Management API with the checked-in, code-only confirmation template, a six-digit OTP, a 600-second OTP expiry, and a 60-second minimum interval between emails. Resend SMTP sent a real signup email to its test recipient; Resend marked it delivered with a six-digit code and no confirmation link. The code confirmed the account through `/signup/verify` and opened the canvas. The disposable account was deleted afterward. The hosted project had a 25-emails-per-hour Auth limit at verification time.

The verification page shows the remaining ten-minute code lifetime and disables resend for the first minute. The server also rejects an early resend. Supabase's own email frequency and hourly limits remain the authoritative protection if a browser clears its timing cookie or submits requests outside the UI. A user may request a new code after one minute if the email was lost; the app never sends another code automatically. A fresh code resets the displayed expiry. Changing the address returns to `/signup` and clears the pending address; visiting `/signup/verify` without a pending signup also returns there. The verify page does not accept an arbitrary address for resend.

An existing confirmed address does not receive another signup confirmation email. Supabase can return a successful-looking response for that signup to avoid exposing account existence, so the verification page uses conditional wording and offers sign-in. On 2026-09-24, the reported Gmail address was already confirmed in hosted `auth.users`, and Resend had no current sending record for that recipient. Sign in with the existing account rather than trying to resend a signup code.

To repeat the hosted setup or test it after deployment:

1. Keep the Resend SMTP credentials and any Supabase Management API token in ignored local secrets or server-side deployment secrets. They are not required as public browser variables. The Management API token needs Auth Config and Project Settings read/write scopes to change the hosted template and OTP settings. [Supabase access token scopes](https://supabase.com/docs/guides/platform/personal-access-tokens#footnotes).
2. After Vercel deployment, set Supabase **Site URL** to the exact HTTPS production app origin and allow `<production-origin>/login` in **Redirect URLs**. ScopeRoom has not been deployed to Vercel, so this production redirect remains untested. Add only the preview or local destinations you actually use. [Supabase redirect reference](https://supabase.com/docs/guides/auth/redirect-urls).
3. In Vercel, set `NEXT_PUBLIC_APP_URL` to the same production origin, plus the hosted `NEXT_PUBLIC_SUPABASE_URL` and publishable key. With Vercel system variables enabled, `VERCEL_PROJECT_PRODUCTION_URL` replaces a stale localhost app URL. Without a public HTTPS origin, hosted signup fails instead of mailing a localhost link.
4. After setting the production origin, sign up with a fresh test address. Inspect the delivered email, enter its code, check the canvas gate and sign-out, and verify the redirect destination. Old emails retain the redirect they were created with.

If a confirmation link is used in a future template, Supabase confirms the address and returns to `/login`; the user then signs in with the password. A temporary PKCE code in that redirect is removed from the visible URL. The signed-in session is stored in cookies, not in the confirmation URL.

Supabase Auth stores accounts and identities in PostgreSQL. At inspection, the hosted `auth.audit_log_entries` table existed but had zero rows; Auth events appeared in external logs. This stage does not add a Prisma profile or application audit table.

Google and other SSO providers remain deferred. `src/features/access/server/auth-handler.ts` owns provider operations for later extension.
