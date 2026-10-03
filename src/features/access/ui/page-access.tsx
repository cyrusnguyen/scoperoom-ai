"use client";

import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

type Admission = "pending" | "verified" | "unavailable";
const PageAdmission = createContext<(admission: Admission) => void>(() => {});

/** Only the server page's result admits the shell. Successful page switches keep its existing instance. */
export function PageAccessBoundary({ shell, unavailable, children }: { shell: ReactNode; unavailable: ReactNode; children: ReactNode }) {
  const [admission, setAdmission] = useState<Admission>("pending");
  return <PageAdmission.Provider value={setAdmission}>
    {admission === "verified" && shell}
    {admission === "unavailable" && unavailable}
    {children}
  </PageAdmission.Provider>;
}

export function PageAccess({ available }: { available: boolean }) {
  const admit = useContext(PageAdmission);
  useLayoutEffect(() => { admit(available ? "verified" : "unavailable"); }, [admit, available]);
  // No cleanup: verified page switches retain the shell. An unavailable result removes its in-memory state.
  return null;
}
