import { useEffect, useState } from "react";
import { getGlobalBoard } from "../api/web.js";

/** Global market board with light polling; degrades to cached rows. */
export default function useGlobalBoard(pollMs = 60_000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getGlobalBoard()
        .then((payload) => {
          if (!alive) return;
          setData(payload);
          setError(null);
          setUpdatedAt(new Date());
        })
        .catch((err) => {
          if (alive) setError(err?.message || String(err));
        });
    load();
    const timer = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pollMs]);

  return { data, error, updatedAt };
}
