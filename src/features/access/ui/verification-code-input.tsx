"use client";

import { useState, type ChangeEvent } from "react";

const CODE_LENGTH = 6;

export default function VerificationCodeInput() {
  const [code, setCode] = useState("");

  function updateCode(event: ChangeEvent<HTMLInputElement>) {
    // Keep paste and one-time-code autofill as a single operation for assistive tech.
    setCode(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH));
  }

  return (
    <>
      <label htmlFor="code">Verification code</label>
      <div className="verification-code">
        <input
          id="code"
          name="code"
          className="verification-input"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          aria-describedby="verification-hint"
          value={code}
          onChange={updateCode}
          required
          maxLength={CODE_LENGTH}
        />
        <div className="verification-digits" aria-hidden="true">
          {Array.from({ length: CODE_LENGTH }, (_, index) => (
            <span className="verification-digit" data-active={index === Math.min(code.length, CODE_LENGTH - 1)} key={index}>{code[index] ?? ""}</span>
          ))}
        </div>
      </div>
      <p id="verification-hint" className="verification-hint">Enter or paste the 6-digit code from your email.</p>
    </>
  );
}