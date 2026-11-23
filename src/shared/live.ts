/**
 * Instant updates over WebRTC data channels, with no server of our own.
 *
 *  - Signalling (a few small messages to set the connection up) goes through the free public ntfy.sh
 *    pub/sub service, on a topic named after the map.
 *  - STUN (free, Google/Cloudflare) lets browsers discover their public address.
 *  - Once connected, map state flows directly GM -> player. If a player's network blocks peer-to-peer
 *    (no free TURN relay exists), they keep working through the GitHub polling fallback.
 */

export const NTFY = "https://ntfy.sh";
export const ICE: RTCConfiguration = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }] };

export type Post = (url: string, body: string) => Promise<void>;
const defaultPost: Post = async (url, body) => { await fetch(url, { method: "POST", body }); };

export const topicFor = (mapId: string) => "pointcrawl-" + mapId.replace(/[^\w-]/g, "");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = new TextEncoder(), dec = new TextDecoder();

/* ------------------------- binary framing for big state ------------------------- */

const CHUNK = 15000;
export function toFrames(text: string, id: number): ArrayBuffer[] {
	const bytes = enc.encode(text);
	const n = Math.max(1, Math.ceil(bytes.length / CHUNK));
	const out: ArrayBuffer[] = [];
	for (let i = 0; i < n; i++) {
		const part = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
		const buf = new ArrayBuffer(8 + part.length);
		const dv = new DataView(buf);
		dv.setUint32(0, id >>> 0); dv.setUint16(4, i); dv.setUint16(6, n);
		new Uint8Array(buf, 8).set(part);
		out.push(buf);
	}
	return out;
}

export class Reassembler {
	private m = new Map<number, { n: number; got: number; parts: Uint8Array[] }>();
	push(buf: ArrayBuffer): string | null {
		if (buf.byteLength < 8) return null;
		const dv = new DataView(buf);
		const id = dv.getUint32(0), i = dv.getUint16(4), n = dv.getUint16(6);
		let e = this.m.get(id);
		if (!e) {
			e = { n, got: 0, parts: new Array(n) };
			this.m.set(id, e);
			for (const k of this.m.keys()) if (k !== id && this.m.size > 4) this.m.delete(k); // drop abandoned messages
		}
		if (!e.parts[i]) { e.parts[i] = new Uint8Array(buf, 8); e.got++; }
		if (e.got < e.n) return null;
		this.m.delete(id);
		const total = new Uint8Array(e.parts.reduce((s, p) => s + p.length, 0));
		let o = 0;
		for (const p of e.parts) { total.set(p, o); o += p.length; }
		return dec.decode(total);
	}
}

/* ------------------------------ ntfy signalling ------------------------------ */

const SIG_CHUNK = 2800; // ntfy messages are limited to 4096 bytes

async function sendSig(post: Post, base: string, topic: string, t: "o" | "a", id: string, sdp: string) {
	const n = Math.ceil(sdp.length / SIG_CHUNK);
	for (let i = 0; i < n; i++) await post(`${base}/${topic}`, JSON.stringify({ v: 1, t, id, i, n, d: sdp.slice(i * SIG_CHUNK, (i + 1) * SIG_CHUNK) }));
}

class SigAssembler {
	private m = new Map<string, { n: number; got: number; parts: string[] }>();
	push(msg: { id: string; i: number; n: number; d: string }): string | null {
		let e = this.m.get(msg.id);
		if (!e) { e = { n: msg.n, got: 0, parts: new Array(msg.n) }; this.m.set(msg.id, e); }
		if (e.parts[msg.i] === undefined) { e.parts[msg.i] = msg.d; e.got++; }
		if (e.got < e.n) return null;
		this.m.delete(msg.id);
		return e.parts.join("");
	}
}

function subscribe(base: string, topic: string, onMsg: (m: any) => void): () => void {
	const es = new EventSource(`${base}/${topic}/sse`);
	es.onmessage = (e) => {
		try {
			const ev = JSON.parse(e.data);
			if (ev.event !== "message") return;
			const m = JSON.parse(ev.message);
			if (m && m.v === 1) onMsg(m);
		} catch { /* not ours */ }
	};
	return () => es.close();
}

function waitIce(pc: RTCPeerConnection, ms = 3000): Promise<void> {
	return new Promise((res) => {
		if (pc.iceGatheringState === "complete") return res();
		const t = setTimeout(res, ms);
		pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } });
	});
}

export interface LiveOpts {
	topic: string;
	post?: Post;
	base?: string;
	ice?: RTCConfiguration;
}

/* --------------------------------- GM side --------------------------------- */

interface Peer { pc: RTCPeerConnection; dc?: RTCDataChannel; open: boolean }

export class LiveHost {
	private peers = new Map<string, Peer>();
	private asm = new SigAssembler();
	private unsub: (() => void) | null = null;
	private seq = 1;
	private timer: number | undefined;
	private beat: number | undefined;
	private base: string; private post: Post;

	constructor(private o: LiveOpts & { getState: () => string | null; onPeers?: (n: number) => void }) {
		this.base = o.base ?? NTFY; this.post = o.post ?? defaultPost;
	}

	get count() { let n = 0; this.peers.forEach((p) => p.open && n++); return n; }

	start() {
		this.unsub = subscribe(this.base, this.o.topic, (m) => {
			if (m.t !== "o") return;
			const sdp = this.asm.push(m);
			if (sdp) void this.accept(m.id, sdp);
		});
		this.beat = window.setInterval(() => this.peers.forEach((p) => { if (p.open && p.dc?.readyState === "open") p.dc.send("ping"); }), 5000);
	}

	stop() {
		this.unsub?.(); this.unsub = null;
		window.clearTimeout(this.timer); window.clearInterval(this.beat);
		[...this.peers.keys()].forEach((id) => this.drop(id));
	}

	/** Push the latest state to everyone, shortly after a burst of changes. */
	broadcastSoon(ms = 120) {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.peers.forEach((p) => void this.sendTo(p)), ms);
	}

	private async sendTo(p: Peer) {
		if (!p.open || p.dc?.readyState !== "open") return;
		const s = this.o.getState();
		if (!s) return;
		for (const f of toFrames(s, this.seq++)) {
			while (p.dc!.bufferedAmount > 1_000_000) await sleep(25);
			if (p.dc!.readyState !== "open") return;
			p.dc!.send(f);
		}
	}

	private drop(id: string) {
		const p = this.peers.get(id);
		if (!p) return;
		this.peers.delete(id);
		try { p.pc.close(); } catch { /* already closed */ }
		this.o.onPeers?.(this.count);
	}

	private async accept(id: string, sdp: string) {
		if (this.peers.has(id) || this.peers.size >= 24) return;
		const pc = new RTCPeerConnection(this.o.ice ?? ICE);
		const peer: Peer = { pc, open: false };
		this.peers.set(id, peer);
		pc.ondatachannel = (e) => {
			const dc = e.channel;
			dc.binaryType = "arraybuffer";
			peer.dc = dc;
			dc.onopen = () => { peer.open = true; this.o.onPeers?.(this.count); void this.sendTo(peer); };
			dc.onclose = () => this.drop(id);
		};
		let t: number | undefined;
		pc.onconnectionstatechange = () => {
			const s = pc.connectionState;
			if (s === "failed" || s === "closed") this.drop(id);
			else if (s === "disconnected") { t = window.setTimeout(() => pc.connectionState === "disconnected" && this.drop(id), 8000); }
			else window.clearTimeout(t);
		};
		window.setTimeout(() => { if (!peer.open) this.drop(id); }, 25000); // never connected
		try {
			await pc.setRemoteDescription({ type: "offer", sdp });
			await pc.setLocalDescription(await pc.createAnswer());
			await waitIce(pc);
			await sendSig(this.post, this.base, this.o.topic, "a", id, pc.localDescription!.sdp);
		} catch { this.drop(id); }
	}
}

/* ------------------------------- player side ------------------------------- */

export class LiveClient {
	private stopped = false;
	private unsub: (() => void) | null = null;
	private cur: { id: string; pc: RTCPeerConnection; asm: SigAssembler } | null = null;
	private base: string; private post: Post;

	constructor(private o: LiveOpts & { onState: (json: string) => void; onStatus?: (connected: boolean) => void }) {
		this.base = o.base ?? NTFY; this.post = o.post ?? defaultPost;
	}

	start() {
		this.unsub = subscribe(this.base, this.o.topic, (m) => {
			const c = this.cur;
			if (m.t !== "a" || !c || m.id !== c.id) return;
			const sdp = c.asm.push(m);
			if (sdp) void c.pc.setRemoteDescription({ type: "answer", sdp }).catch(() => c.pc.close());
		});
		void this.run();
	}

	stop() {
		this.stopped = true;
		this.unsub?.();
		this.cur?.pc.close();
	}

	private async run() {
		let fails = 0;
		while (!this.stopped) {
			let ok = false;
			try { ok = await this.connectOnce(); } catch { /* retry */ }
			this.o.onStatus?.(false);
			fails = ok ? 0 : fails + 1;
			await sleep(ok ? 1500 : Math.min(60000, 4000 * 2 ** Math.min(fails, 4)));
		}
	}

	/** One connection attempt. Resolves true if it connected (and then later dropped). */
	private async connectOnce(): Promise<boolean> {
		const id = Math.random().toString(36).slice(2, 10);
		const pc = new RTCPeerConnection(this.o.ice ?? ICE);
		this.cur = { id, pc, asm: new SigAssembler() };
		const dc = pc.createDataChannel("pc");
		dc.binaryType = "arraybuffer";
		const re = new Reassembler();
		let last = Date.now();
		dc.onmessage = (e) => {
			last = Date.now();
			if (typeof e.data === "string") return; // heartbeat
			const s = re.push(e.data as ArrayBuffer);
			if (s) this.o.onState(s);
		};
		const closed = new Promise<void>((res) => {
			dc.onclose = () => res();
			pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "closed") res(); };
		});
		const opened = new Promise<boolean>((res) => { dc.onopen = () => res(true); window.setTimeout(() => res(false), 15000); });
		try {
			await pc.setLocalDescription(await pc.createOffer());
			await waitIce(pc);
			await sendSig(this.post, this.base, this.o.topic, "o", id, pc.localDescription!.sdp);
			if (!(await opened)) return false;
			this.o.onStatus?.(true);
			const watchdog = window.setInterval(() => { if (Date.now() - last > 14000) pc.close(); }, 3000); // GM vanished without closing
			await Promise.race([closed, new Promise<void>((r) => { const t = window.setInterval(() => { if (this.stopped) { clearInterval(t); r(); } }, 500); })]);
			clearInterval(watchdog);
			return true;
		} finally {
			try { pc.close(); } catch { /* already closed */ }
		}
	}
}
