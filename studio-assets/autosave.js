/**
 * Server autosave state machine.
 *
 * The store already keeps a localStorage recovery draft, but that draft dies with the
 * browser. This mirrors every committed edit to the server, coalescing bursts into one
 * request so a slider drag does not become fifty PUTs.
 *
 * States: idle → dirty → saving → idle | retry_wait | conflict | error.
 * A conflict is terminal: the local draft and the server's revision disagree, and only a
 * human can decide which one wins, so retrying would silently overwrite someone's work.
 */

const DEBOUNCE_MS = 1500;
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

export function createAutosave({
  store,
  createProject,
  saveProject,
  onStateChange = () => {},
  onSaved = () => {},
  shouldUpdate = () => true,
  debounceMs = DEBOUNCE_MS,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  let status = 'idle';
  let revision = null;
  let conflict = null;
  let error = null;
  let timer = null;
  let inFlight = false;
  let pending = false;
  let retryIndex = 0;
  let activePromise = null;

  function snapshot() {
    return { status, currentRevision: revision, currentProject: conflict };
  }

  function setStatus(next, { error: nextError = null } = {}) {
    status = next;
    error = nextError;
    onStateChange(snapshot());
  }

  function cancelTimer() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  }

  function schedule(delay) {
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, delay);
  }

  async function persist() {
    const draft = store.getProject();
    let stored;
    if (!draft.projectId) {
      stored = await createProject(draft);
    } else {
      stored = await saveProject(draft, store.getRevision());
    }
    const adopt = shouldUpdate();
    if (typeof store.setServerIdentity === 'function') {
      store.setServerIdentity(stored.project?.projectId, stored.revision);
    } else {
      store.setServerRevision(stored.revision);
    }
    revision = stored.revision;
    // Re-adopting the server copy mid-session would replace the project object the user is
    // still editing (and reset scroll/focus in every panel), so the caller decides whether
    // this save should also become the local document.
    if (adopt) {
      store.setProject(stored.project, { fromServer: true });
    }
    // A successful save means the server has a durable copy, so the crash-recovery draft can
    // go even when this save did not replace the local project object.
    store.clearRecovery();
    onSaved(stored);
    return stored;
  }

  function handleFailure(failure) {
    const statusCode = typeof failure?.status === 'number' ? failure.status : 0;

    if (statusCode === 409) {
      conflict = failure.body?.project ?? null;
      revision = failure.body?.currentRevision ?? revision;
      // A conflict stops automatic retries: the next write would clobber the server copy.
      cancelTimer();
      setStatus('conflict');
      return;
    }

    // A zero status is a transport failure (offline, DNS, reset) and is as retryable as 5xx.
    const retryable = statusCode === 0 || statusCode >= 500;
    if (!retryable) {
      setStatus('error', { error: failure });
      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    setStatus('retry_wait', { error: failure });
    schedule(delay);
  }

  async function flush() {
    cancelTimer();
    if (inFlight) {
      // Coalesce: the in-flight request finishes, then one more request covers everything.
      pending = true;
      return activePromise;
    }
    if (status === 'conflict') return null;

    inFlight = true;
    pending = false;
    setStatus('saving');

    activePromise = (async () => {
      try {
        const stored = await persist();
        retryIndex = 0;
        setStatus('idle');
        return stored;
      } catch (failure) {
        handleFailure(failure);
        return null;
      } finally {
        inFlight = false;
        activePromise = null;
        if (pending && status !== 'conflict' && status !== 'error') {
          pending = false;
          void flush();
        }
      }
    })();

    return activePromise;
  }

  return {
    /** Called on every committed edit; bursts collapse into one request. */
    markDirty() {
      if (status === 'conflict') return;
      if (inFlight) {
        pending = true;
        return;
      }
      retryIndex = 0;
      setStatus('dirty');
      schedule(debounceMs);
    },

    /** Forces an immediate save, used by the manual Save button. */
    flush,

    /** Adopts a server revision after the library opened a project. */
    adopt({ revision: nextRevision = null } = {}) {
      revision = nextRevision;
      conflict = null;
      retryIndex = 0;
      cancelTimer();
      setStatus('idle');
    },

    /** Drops the saved server copy and keeps editing as a fresh project. */
    reset() {
      conflict = null;
      revision = null;
      retryIndex = 0;
      cancelTimer();
      setStatus('idle');
    },

    dispose() {
      cancelTimer();
      pending = false;
    },

    getState: snapshot,
    getError: () => error,
  };
}
