"use client";

/**
 * Polls /api/version with If-None-Match every 5 s and re-renders the page
 * when it moves. While text in <main> is selected it waits, so an update
 * never drops a selection. When the portal stops answering it says so, backs
 * off to 30 s, and refreshes as soon as it answers again.
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 5_000;
const MAX_MS = 30_000;

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function Live() {
  const router = useRouter();
  const [state, setState] = useState<{ tone: "live" | "paused" | "offline"; text: string }>({ tone: "live", text: "Live" });
  const etag = useRef<string | null>(null);

  useEffect(() => {
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    let updated = new Date();
    let stopped = false;

    const selecting = () => {
      const s = getSelection();
      return s !== null && !s.isCollapsed && document.querySelector("main")?.contains(s.anchorNode) === true;
    };

    async function poll() {
      clearTimeout(timer);
      try {
        const response = await fetch("/api/version", { headers: etag.current === null ? {} : { "if-none-match": etag.current }, cache: "no-store" });
        if (response.status !== 200 && response.status !== 304) throw new Error(String(response.status));
        const next = response.headers.get("etag");
        if (etag.current === null) etag.current = next;
        else if (response.status === 200 && next !== etag.current) {
          etag.current = next;
          pending = true;
        }
        if (pending && selecting()) setState({ tone: "paused", text: "Update waiting · clear your selection" });
        else {
          if (pending) {
            router.refresh();
            pending = false;
            updated = new Date();
          }
          setState({ tone: "live", text: `Live · updated ${clock(updated)}` });
        }
        delay = POLL_MS;
      } catch {
        delay = Math.min(delay * 2, MAX_MS);
        setState({ tone: "offline", text: `Portal unreachable · showing ${clock(updated)} · retrying in ${Math.round(delay / 1000)} s` });
      }
      if (!stopped && !document.hidden) timer = setTimeout(poll, delay);
    }

    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    const onSelection = () => {
      if (pending && !selecting()) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("selectionchange", onSelection);
    setState({ tone: "live", text: `Live · updated ${clock(updated)}` });
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [router]);

  return (
    <span id="live" className="live" role="status" data-state={state.tone}>
      <span className="dot" />
      <span className="live-text">{state.text}</span>
    </span>
  );
}
