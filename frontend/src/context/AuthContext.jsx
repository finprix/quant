import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getAuthSession, loginDeveloper, logoutDeveloper } from "../api/client.js";

/**
 * Access roles:
 *   null        — entry gate (no session chosen yet)
 *   "guest"     — read-only research mode (backend enforces all limits)
 *   "developer" — dataset administration + research (PIN-verified)
 *
 * Guest choice persists locally for convenience only; every privileged
 * operation is enforced server-side by require_developer().
 */
const GUEST_KEY = "market-dna.guest";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [role, setRole] = useState(null);
  const [loginError, setLoginError] = useState(null);
  const [authenticating, setAuthenticating] = useState(false);

  // Restore session state on boot: a valid developer cookie survives
  // refreshes; guests are remembered for convenience.
  useEffect(() => {
    let cancelled = false;
    getAuthSession()
      .then((session) => {
        if (cancelled) return;
        if (session?.authenticated && session.role === "developer") {
          setRole("developer");
          window.localStorage.removeItem(GUEST_KEY);
        } else if (window.localStorage.getItem(GUEST_KEY) === "1") {
          setRole("guest");
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const enterAsGuest = useCallback(() => {
    window.localStorage.setItem(GUEST_KEY, "1");
    setRole("guest");
    setLoginError(null);
  }, []);

  const login = useCallback(async (pin) => {
    setAuthenticating(true);
    setLoginError(null);
    try {
      const result = await loginDeveloper(pin);
      window.localStorage.removeItem(GUEST_KEY);
      setRole(result.role === "developer" ? "developer" : "guest");
      return true;
    } catch (error) {
      setLoginError(error?.message || "Login failed.");
      return false;
    } finally {
      setAuthenticating(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutDeveloper();
    } catch {
      /* clearing local state regardless */
    }
    window.localStorage.removeItem(GUEST_KEY);
    setRole(null);
    setLoginError(null);
  }, []);

  const value = useMemo(
    () => ({
      ready,
      role,
      isDeveloper: role === "developer",
      isGuest: role === "guest",
      loginError,
      authenticating,
      login,
      enterAsGuest,
      logout,
    }),
    [ready, role, loginError, authenticating, login, enterAsGuest, logout],
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
