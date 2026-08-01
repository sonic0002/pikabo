/**
 * Minimal ambient declarations for the extension APIs used inside `evaluate` callbacks.
 *
 * These bodies are serialised and run inside the browser, where the real `chrome` object
 * exists. Depending on `@types/chrome` for a handful of call sites would pull a large type
 * package into every consumer of this library, so only what is used is declared here.
 */
declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    const local: StorageArea;
    const sync: StorageArea;
    const session: StorageArea;
  }

  namespace runtime {
    const id: string;
    function reload(): void;
    function getManifest(): Record<string, unknown>;
    function sendMessage(message: unknown): Promise<unknown>;
  }

  namespace permissions {
    function contains(request: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  }
}
