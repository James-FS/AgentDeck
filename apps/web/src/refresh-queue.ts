/** Serialize refreshes and retain one pending pass when events arrive in flight. */
export function createRefreshQueue(run: (full: boolean) => Promise<void>) {
  let active: Promise<void> | null = null;
  let pending = false;
  let fullPending = false;
  return (full = false): Promise<void> => {
    pending = true; fullPending ||= full;
    if (active) return active;
    active = (async () => {
      try {
        while (pending) {
          const includeMetadata = fullPending;
          pending = false; fullPending = false;
          try { await run(includeMetadata); }
          catch (error) { if (!pending) throw error; /* a newer event still gets its own read */ }
        }
      } finally { active = null; }
    })();
    return active;
  };
}
