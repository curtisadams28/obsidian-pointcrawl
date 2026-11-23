import { requestUrl } from "obsidian";

export interface GHConfig { token: string; repo: string; branch: string; pagesUrl: string }

export function toBase64(buf: ArrayBuffer): string {
	const b = new Uint8Array(buf);
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s);
}
export const textToBase64 = (t: string) => toBase64(new TextEncoder().encode(t).buffer as ArrayBuffer);

export function playerUrl(c: GHConfig, mapId: string, instant = true): string {
	const [owner, name] = c.repo.split("/");
	let base = c.pagesUrl.trim();
	if (!base) base = name?.toLowerCase() === `${owner}.github.io`.toLowerCase() ? `https://${owner}.github.io/` : `https://${owner}.github.io/${name}/`;
	if (!base.endsWith("/")) base += "/";
	return `${base}?r=${encodeURIComponent(c.repo)}&b=${encodeURIComponent(c.branch)}&m=${encodeURIComponent(mapId)}${instant ? "" : "&p=0"}`;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export class GitHub {
	private shas = new Map<string, string | null>();
	private branchOk = "";
	constructor(private cfg: () => GHConfig) {}

	private async api(method: string, path: string, body?: unknown) {
		const c = this.cfg();
		return requestUrl({
			url: `https://api.github.com/repos/${c.repo}${path}`,
			method,
			headers: {
				Authorization: `Bearer ${c.token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			throw: false,
		});
	}

	private fail(r: { status: number; json: any; text: string }, what: string): never {
		const msg = r.json?.message ?? r.text;
		if (r.status === 401) throw new Error("GitHub rejected the token (401). Check it and its expiry.");
		if (r.status === 403 || r.status === 429) throw new Error(`GitHub refused the request (${r.status}): ${msg}. If this is a rate limit, wait a minute.`);
		if (r.status === 404) throw new Error(`${what}: not found (404). Check the repository name and that the token has access to it.`);
		throw new Error(`${what}: GitHub ${r.status} ${msg}`);
	}

	configured(): string | null {
		const c = this.cfg();
		if (!c.token) return "Add a GitHub access token in the Point Crawl settings.";
		if (!/^[^/\s]+\/[^/\s]+$/.test(c.repo)) return "Set the repository (owner/name) in the Point Crawl settings.";
		return null;
	}

	async test(): Promise<string> {
		const bad = this.configured();
		if (bad) throw new Error(bad);
		const r = await this.api("GET", "");
		if (r.status !== 200) this.fail(r, "Repository");
		if (r.json?.permissions && !r.json.permissions.push) throw new Error("Connected, but the token cannot write to this repo. Give it Contents: read and write.");
		await this.ensureBranch();
		return `Connected to ${r.json.full_name}. Data branch "${this.cfg().branch}" is ready.`;
	}

	async ensureBranch() {
		const c = this.cfg();
		const key = `${c.repo}#${c.branch}`;
		if (this.branchOk === key) return;
		const br = await this.api("GET", `/branches/${enc(c.branch)}`);
		if (br.status === 200) { this.branchOk = key; return; }
		if (br.status !== 404) this.fail(br, "Branch lookup");
		const repo = await this.api("GET", "");
		if (repo.status !== 200) this.fail(repo, "Repository");
		const def = repo.json.default_branch;
		const ref = await this.api("GET", `/git/ref/heads/${enc(def)}`);
		if (ref.status !== 200) {
			if (ref.status === 404 || ref.status === 409) throw new Error("The repository is empty. Create a README in it first so a branch exists.");
			this.fail(ref, "Default branch");
		}
		const mk = await this.api("POST", "/git/refs", { ref: `refs/heads/${c.branch}`, sha: ref.json.object.sha });
		if (mk.status !== 201) this.fail(mk, "Create data branch");
		this.branchOk = key;
	}

	private async getSha(path: string): Promise<string | null> {
		const r = await this.api("GET", `/contents/${enc(path)}?ref=${encodeURIComponent(this.cfg().branch)}`);
		if (r.status === 404) return null;
		if (r.status !== 200) this.fail(r, "Read " + path);
		return r.json.sha as string;
	}

	/** Create or update a file on the data branch. */
	async put(path: string, base64: string, message: string) {
		const c = this.cfg();
		for (let attempt = 0; attempt < 2; attempt++) {
			let sha = this.shas.get(path);
			if (sha === undefined) { sha = await this.getSha(path); this.shas.set(path, sha); }
			const r = await this.api("PUT", `/contents/${enc(path)}`, { message, content: base64, branch: c.branch, ...(sha ? { sha } : {}) });
			if (r.status === 200 || r.status === 201) { this.shas.set(path, r.json.content.sha); return; }
			if (r.status === 409 || r.status === 422) { this.shas.delete(path); continue; }
			this.fail(r, "Upload " + path);
		}
		throw new Error(`Could not update ${path} (conflicting writes). Try again.`);
	}
}

/** Coalesces rapid changes into one push and never runs two at once. */
export class PublishQueue {
	private timer: number | undefined;
	private running = false;
	private again = false;
	constructor(private job: () => Promise<void>, private status: (msg: string, error: boolean) => void) {}

	schedule(ms: number) {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.run(), ms);
	}

	cancel() { window.clearTimeout(this.timer); }

	async run(): Promise<boolean> {
		window.clearTimeout(this.timer);
		if (this.running) { this.again = true; return true; }
		this.running = true;
		let ok = true;
		try {
			do {
				this.again = false;
				this.status("Syncing…", false);
				await this.job();
			} while (this.again);
			this.status(`Synced ${new Date().toLocaleTimeString()}`, false);
		} catch (e) {
			ok = false;
			this.status((e as Error).message, true);
		} finally {
			this.running = false;
		}
		return ok;
	}
}
