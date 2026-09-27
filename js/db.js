/* IndexedDB-backed progress store — mirrors the native app's Room tables:
   readPages (per-page read tracking), attempts + questionAttempts (test history). */
const DB = (() => {
  const DB_NAME = 'koreklar-progress';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('readPages')) {
          db.createObjectStore('readPages', { keyPath: 'pageId' });
        }
        if (!db.objectStoreNames.contains('attempts')) {
          const store = db.createObjectStore('attempts', { keyPath: 'id', autoIncrement: true });
          store.createIndex('testId', 'testId');
        }
        if (!db.objectStoreNames.contains('questionAttempts')) {
          const store = db.createObjectStore('questionAttempts', { keyPath: 'id', autoIncrement: true });
          store.createIndex('attemptId', 'attemptId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = Array.isArray(storeNames)
        ? storeNames.map((n) => t.objectStore(n))
        : t.objectStore(storeNames);
      let result;
      Promise.resolve(fn(stores, t)).then((r) => { result = r; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
    });
  }

  return {
    async markRead(moduleId, chapterId, pageId) {
      return tx('readPages', 'readwrite', (store) => {
        store.put({ pageId, moduleId, chapterId, readAt: Date.now() });
      });
    },

    async getReadPageIds() {
      return tx('readPages', 'readonly', (store) => new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(new Set(req.result.map((r) => r.pageId)));
        req.onerror = () => reject(req.error);
      }));
    },

    async insertAttempt(attempt) {
      return tx('attempts', 'readwrite', (store) => new Promise((resolve, reject) => {
        const req = store.add(attempt);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    },

    async insertQuestionAttempts(list) {
      return tx('questionAttempts', 'readwrite', (store) => {
        list.forEach((qa) => store.add(qa));
      });
    },

    async getAllAttempts() {
      return tx('attempts', 'readonly', (store) => new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result.sort((a, b) => b.takenAt - a.takenAt));
        req.onerror = () => reject(req.error);
      }));
    },

    async getAttempt(id) {
      return tx('attempts', 'readonly', (store) => new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      }));
    },

    async getAttemptsForTest(testId) {
      return tx('attempts', 'readonly', (store) => new Promise((resolve, reject) => {
        const req = store.index('testId').getAll(testId);
        req.onsuccess = () => resolve(req.result.sort((a, b) => b.takenAt - a.takenAt));
        req.onerror = () => reject(req.error);
      }));
    },

    async getQuestionAttempts(attemptId) {
      return tx('questionAttempts', 'readonly', (store) => new Promise((resolve, reject) => {
        const req = store.index('attemptId').getAll(attemptId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    },
  };
})();
