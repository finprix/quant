import { useEffect, useState } from "react";
import { request } from "../api/client.js";

const TTL_MS = 60_000;

/**
 * Live quote for one symbol, polled every 60 s (backend caches upstream).
 * Returns null while loading or when the symbol has no live quote.
 */
export default function useLiveQuote(symbol) {
  const [quote, setQuote] = useState(null);

  useEffect(() => {
    setQuote(null);
    if (!symbol) return undefined;
    let alive = true;
    const load = () =>
      request(`/market/quote/${encodeURIComponent(symbol)}`)
        .then((q) => alive && setQuote(q))
        .catch(() => {});
    load();
    const timer = setInterval(load, TTL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [symbol]);

  return quote;
}
