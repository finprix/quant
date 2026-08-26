import { lazy } from "react";

const RELOAD_FLAG = "finprix.chunk-reload-done";

async function attempt(factory, retriesLeft) {
  try {
    return await factory();
  } catch (err) {
    if (retriesLeft > 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return attempt(factory, retriesLeft - 1);
    }
    /*
     * A failed dynamic import after a redeploy means this tab is holding
     * an outdated index.html whose hashed chunks no longer exist. One
     * silent reload per session picks up the fresh bundle instead of
     * showing the user a crash screen.
     */
    if (typeof window !== "undefined" && !window.sessionStorage.getItem(RELOAD_FLAG)) {
      window.sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
      return new Promise(() => {});
    }
    throw err;
  }
}

/** React.lazy that survives stale-bundle chunk failures across deploys. */
export function lazyWithRetry(factory) {
  return lazy(() => attempt(factory, 1));
}
