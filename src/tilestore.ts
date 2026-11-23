/** Persistent tile cache (IndexedDB). Tiles are derived data, so it's safe to wipe at any time. */

export interface TileMeta {
	key: string;
	/** Vault path of the source image (used to drop stale caches of the same file). */
	path: string;
	/** World size = size of the decoded image, level 0. */
	w: number; h: number;
	tile: number;
	levels: number;
	built: number[];
	complete: boolean;
	mime: string;
}

const DB = "pointcrawl-tiles";

export class TileStore {
	private db: IDBDatabase | null = null;
	private mem = new Map<string, Blob>();
	private memMeta = new Map<string, TileMeta>();
	private opening: Promise<void> | null = null;

	/** Safe to call repeatedly. Falls back to memory if IndexedDB is unavailable. */
	ready(): Promise<void> {
		return (this.opening ??= new Promise<void>((res) => {
			try {
				const r = indexedDB.open(DB, 1);
				r.onupgradeneeded = () => { r.result.createObjectStore("meta", { keyPath: "key" }); r.result.createObjectStore("tiles"); };
				r.onsuccess = () => { this.db = r.result; res(); };
				r.onerror = () => res();
				r.onblocked = () => res();
			} catch { res(); }
		}));
	}

	private run<T>(store: "meta" | "tiles", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		return new Promise((res, rej) => {
			const tx = this.db!.transaction(store, mode);
			const r = fn(tx.objectStore(store));
			tx.oncomplete = () => res(r.result);
			tx.onerror = () => rej(tx.error);
			tx.onabort = () => rej(tx.error);
		});
	}

	private tk = (key: string, l: number, x: number, y: number) => `${key}/${l}/${x}_${y}`;

	async getMeta(key: string): Promise<TileMeta | null> {
		if (!this.db) return this.memMeta.get(key) ?? null;
		return ((await this.run("meta", "readonly", (s) => s.get(key))) as TileMeta | undefined) ?? null;
	}

	async putMeta(m: TileMeta) {
		if (!this.db) { this.memMeta.set(m.key, { ...m }); return; }
		await this.run("meta", "readwrite", (s) => s.put({ ...m }));
	}

	async putTile(key: string, l: number, x: number, y: number, blob: Blob) {
		if (!this.db) { this.mem.set(this.tk(key, l, x, y), blob); return; }
		await this.run("tiles", "readwrite", (s) => s.put(blob, this.tk(key, l, x, y)));
	}

	async getTile(key: string, l: number, x: number, y: number): Promise<Blob | null> {
		if (!this.db) return this.mem.get(this.tk(key, l, x, y)) ?? null;
		return ((await this.run("tiles", "readonly", (s) => s.get(this.tk(key, l, x, y)))) as Blob | undefined) ?? null;
	}

	async deleteKey(key: string) {
		if (!this.db) {
			this.memMeta.delete(key);
			for (const k of [...this.mem.keys()]) if (k.startsWith(key + "/")) this.mem.delete(k);
			return;
		}
		await this.run("tiles", "readwrite", (s) => s.delete(IDBKeyRange.bound(key + "/", key + "/\uffff")));
		await this.run("meta", "readwrite", (s) => s.delete(key));
	}

	/** Drop caches of the same image path that don't match the current version. */
	async deleteStale(path: string, keep: string) {
		const all = this.db ? ((await this.run("meta", "readonly", (s) => s.getAll())) as TileMeta[]) : [...this.memMeta.values()];
		for (const m of all) if (m.path === path && m.key !== keep) await this.deleteKey(m.key);
	}

	async clearAll() {
		this.mem.clear(); this.memMeta.clear();
		if (!this.db) return;
		await this.run("tiles", "readwrite", (s) => s.clear());
		await this.run("meta", "readwrite", (s) => s.clear());
	}
}
