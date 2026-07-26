"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page on the server while a job is running (PRD Phase 13 task 2).
 *
 * This component renders nothing and holds nothing. Its only effect is to ask Next.js to re-run the
 * *server* render, which re-reads `GET /api/jobs/:jobId` and `GET /api/jobs/:jobId/events` through
 * the `server-only` API client. Every progress value on the page therefore comes from the persisted
 * job row, exactly as it would after a manual reload.
 *
 * That is why this is a refresh rather than a fetch. A browser-side poll would put product state in
 * the browser, would need the API's address there, and would show a stage the server had not
 * confirmed. PRD section 15.10 permits server-sent events; the installed API exposes the event list
 * as a read, so refreshing the read is the shape it actually supports.
 *
 * `active` is decided by the server from the job's persisted status, so a job that finished while
 * the page was closed renders terminal and never starts an interval at all.
 */
export function AutoRefresh(props: {
  readonly active: boolean;
  readonly intervalMs?: number;
}): null {
  const router = useRouter();
  const active = props.active;
  const intervalMs = props.intervalMs ?? 2000;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      router.refresh();
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [active, intervalMs, router]);

  return null;
}
