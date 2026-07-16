// tiny IndexedDB kv: persists the folder handle, sessions, and snapshots across reloads
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open("automo", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbSet(k: string, v: unknown): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite");
    t.objectStore("kv").put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
export async function idbGet<T = unknown>(k: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readonly");
    const g = t.objectStore("kv").get(k);
    g.onsuccess = () => res(g.result as T);
    g.onerror = () => rej(g.error);
  });
}
