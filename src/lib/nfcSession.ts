import { armScanning, isNfcSupported } from "./nfc";

/**
 * The round's NFC reader, owned outside React.
 *
 * Chrome only grants the NFC permission from inside a live user gesture, and the gesture that
 * begins a round is now the setup screen's "Start round" press — by the time the round map
 * mounts there is no gesture left to arm from. A reader owned by a component would also die
 * with it on navigation. So the reader lives here for the length of the round instead, and
 * screens subscribe to it.
 */

type TagListener = (serialNumber: string, at: Date) => void;
type MessageListener = (message: string) => void;
type StateListener = (active: boolean) => void;

let stop: (() => void) | null = null;
let starting: Promise<void> | null = null;
const tagListeners = new Set<TagListener>();
const errorListeners = new Set<MessageListener>();
const stateListeners = new Set<StateListener>();

function emitState() {
  const active = stop !== null;
  for (const listener of stateListeners) listener(active);
}

/**
 * Arms scanning for the round. MUST be reached from a user gesture, and called before any
 * `await` in that handler — awaiting first spends the activation and Chrome rejects the scan.
 * Safe to call again while already armed; resolves to whether scanning is live.
 */
export async function startNfcSession(): Promise<boolean> {
  if (!isNfcSupported()) return false;
  if (stop) return true;
  if (!starting) {
    starting = (async () => {
      try {
        stop = await armScanning(
          (serial, at) => {
            for (const listener of tagListeners) listener(serial, at);
          },
          (message) => {
            for (const listener of errorListeners) listener(message);
          }
        );
      } catch {
        stop = null; // unsupported, permission denied, or NFC switched off
      }
    })().finally(() => {
      starting = null;
      emitState();
    });
  }
  await starting;
  return stop !== null;
}

export function stopNfcSession(): void {
  stop?.();
  stop = null;
  emitState();
}

export function isNfcSessionActive(): boolean {
  return stop !== null;
}

/** Subscribes to tag reads. Returns an unsubscribe — the session itself keeps running. */
export function onNfcTag(listener: TagListener): () => void {
  tagListeners.add(listener);
  return () => tagListeners.delete(listener);
}

export function onNfcError(listener: MessageListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

export function onNfcStateChange(listener: StateListener): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}
