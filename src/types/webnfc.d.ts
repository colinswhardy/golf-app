// Minimal Web NFC ambient types — TypeScript's DOM lib doesn't ship NDEFReader.
// Only the surface lib/nfc.ts actually uses. Chrome-on-Android-only API.

interface NDEFRecord {
  recordType: string;
  mediaType?: string;
  id?: string;
  data?: DataView;
}

interface NDEFMessage {
  records: readonly NDEFRecord[];
}

interface NDEFReadingEvent extends Event {
  /** Hardware serial of the tag, e.g. "04:1a:2b:3c:4d:5e:6f". Stable per physical tag — the
   * pairing key; written NDEF content is deliberately ignored. */
  serialNumber: string;
  message: NDEFMessage;
}

interface NDEFScanOptions {
  signal?: AbortSignal;
}

declare class NDEFReader extends EventTarget {
  constructor();
  scan(options?: NDEFScanOptions): Promise<void>;
  onreading: ((this: NDEFReader, event: NDEFReadingEvent) => void) | null;
  onreadingerror: ((this: NDEFReader, event: Event) => void) | null;
}
