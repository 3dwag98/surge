/**
 * localStorage wrapper that never throws.
 *
 * Private browsing modes and storage-disabled browsers turn ordinary reads and
 * writes into exceptions, which would otherwise take the whole game down.
 * When storage is unusable this falls back to an in-memory map so the session
 * still works, it just does not survive a reload.
 */

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    persistent: false,
  };
}

/**
 * @param {Storage|undefined} candidate Usually `window.localStorage`.
 * @returns {{getItem: Function, setItem: Function, removeItem: Function,
 *            getJSON: Function, setJSON: Function, persistent: boolean}}
 */
export function createStorage(candidate) {
  let backing = createMemoryStorage();

  if (candidate) {
    try {
      const probe = '__2048_probe__';
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      backing = candidate;
      backing.persistent = true;
    } catch {
      // Keep the in-memory fallback.
    }
  }

  const safe = {
    persistent: backing.persistent !== false,
    getItem(key) {
      try {
        return backing.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        backing.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    removeItem(key) {
      try {
        backing.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
    /** Parse a stored JSON value, returning `fallback` if it is missing or corrupt. */
    getJSON(key, fallback = null) {
      const raw = safe.getItem(key);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        safe.removeItem(key);
        return fallback;
      }
    },
    setJSON(key, value) {
      try {
        return safe.setItem(key, JSON.stringify(value));
      } catch {
        return false;
      }
    },
  };

  return safe;
}
