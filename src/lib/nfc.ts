/**
 * Web NFC club-tag scanning (REVISION-SPEC 2.1). Chrome-on-Android only, and only while the
 * page is VISIBLE — the OS suspends NFC delivery when the screen is off or the app is hidden,
 * which is why the round screen also holds a wake lock (2.2). Tags are identified purely by
 * hardware serialNumber; nothing is ever written to them.
 */

export function isNfcSupported(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

/**
 * Arms continuous NFC scanning. MUST be called from within a user gesture (Chrome requires the
 * "nfc" permission grant to originate from one — the round screen's Start button qualifies).
 * Automatically re-arms when the document becomes visible again, since NFC operations are
 * aborted/suspended while hidden. Returns a stop function that tears everything down.
 */
export async function armScanning(
  onTag: (serialNumber: string, at: Date) => void,
  onError?: (message: string) => void
): Promise<() => void> {
  if (!isNfcSupported()) throw new Error("Web NFC is not supported in this browser.");

  let stopped = false;
  let abort: AbortController | null = null;

  async function startScan() {
    if (stopped) return;
    abort?.abort();
    abort = new AbortController();
    const reader = new NDEFReader();
    reader.onreading = (event) => {
      if (!stopped) onTag(event.serialNumber, new Date());
    };
    reader.onreadingerror = () => {
      onError?.("Tag read failed — try again.");
    };
    try {
      await reader.scan({ signal: abort.signal });
    } catch (e) {
      if (!stopped) onError?.(e instanceof Error ? e.message : String(e));
    }
  }

  const onVisibility = () => {
    if (document.visibilityState === "visible") startScan();
  };
  document.addEventListener("visibilitychange", onVisibility);

  await startScan();

  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    abort?.abort();
  };
}

/** One-shot scan for the Settings pairing flow: resolves with the first serial read, then stops.
 * Also gesture-gated. The returned cancel function abandons the wait. */
export function scanOnce(
  onSerial: (serialNumber: string) => void,
  onError?: (message: string) => void
): () => void {
  let cancelled = false;
  let stop: (() => void) | null = null;
  armScanning(
    (serial) => {
      if (cancelled) return;
      cancelled = true;
      stop?.();
      onSerial(serial);
    },
    (msg) => {
      if (!cancelled) onError?.(msg);
    }
  )
    .then((s) => {
      stop = s;
      if (cancelled) s();
    })
    .catch((e) => {
      if (!cancelled) onError?.(e instanceof Error ? e.message : String(e));
    });
  return () => {
    cancelled = true;
    stop?.();
  };
}
