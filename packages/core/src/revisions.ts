interface RevisionSource {
  getChangeVersions(keys: readonly string[]): ReadonlyMap<string, number>;
}

interface Watch {
  version: number;
  listeners: Set<() => void>;
}

// Read only persisted revisions. Each adapter uses one timer irrespective of
// how many sessions its clients watch. Consumers re-read the latest snapshot.
export function createRevisionWatcher(source: RevisionSource, onError: (error: unknown) => void = () => {}) {
  const watched = new Map<string, Watch>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;

  function tick() {
    try {
      const versions = source.getChangeVersions([...watched.keys()]);
      for (const [key, watch] of watched) {
        const version = versions.get(key) ?? 0;
        if (version === watch.version) continue;
        watch.version = version;
        for (const listener of [...watch.listeners]) {
          try { listener(); }
          catch (error) { onError(error); }
        }
      }
    } catch (error) { onError(error); }
  }

  function stop() {
    clearInterval(timer);
    timer = undefined;
  }

  return {
    watch(key: string, listener: () => void) {
      if (closed) throw new Error('Revision watcher is closed.');
      let watch = watched.get(key);
      if (!watch) {
        watch = { version: source.getChangeVersions([key]).get(key) ?? 0, listeners: new Set() };
        watched.set(key, watch);
      }
      const subscription = () => listener();
      watch.listeners.add(subscription);
      timer ??= setInterval(tick, 300).unref();
      return () => {
        if (watched.get(key) !== watch) return;
        watch.listeners.delete(subscription);
        if (watch.listeners.size === 0) watched.delete(key);
        if (watched.size === 0) stop();
      };
    },
    close() {
      closed = true;
      stop();
      watched.clear();
    },
  };
}

export type RevisionWatcher = ReturnType<typeof createRevisionWatcher>;
