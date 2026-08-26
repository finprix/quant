import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getAuthSession } from "../api/client.js";

/**
 * FINPRIX is public (v0.20.0): everyone browses immediately — there is no
 * access gate. The historical developer/PIN infrastructure survives
 * server-side for administrative endpoints only; if a valid developer
 * cookie happens to exist it is restored silently. No login UI exists.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState("guest");

  useEffect(() => {
    let cancelled = false;
    getAuthSession()
      .then((session) => {
        if (cancelled) return;
        if (session?.authenticated && session.role === "developer") {
          setRole("developer");
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo(
    () => ({
      ready,
      role,
      isDeveloper: role === "developer",
      isGuest: role === "guest",
      loginError: null,
      authenticating: false,
    }),
    [ready, role],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>.");
  }
  return context;
}
