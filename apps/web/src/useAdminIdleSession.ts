import { useEffect, useRef } from 'react';
export type AdminSessionInfo = {
    syncId: string;
    expiresAt: number;
    serverNow: number;
};
const BUS = 'adl.admin.session', LIMIT = 300000;
type Message = {
    type: 'activity' | 'logout' | 'login';
    syncId: string;
    expiresAt?: number;
    serverNow?: number;
    nonce: number;
};
export function announceAdminSession(type: Message['type'], syncId: string, info?: AdminSessionInfo) {
    if (!syncId)
        return;
    const message: Message = { type, syncId, ...(info ? { expiresAt: info.expiresAt, serverNow: info.serverNow } : {}), nonce: Math.random() };
    try {
        localStorage.setItem(BUS, JSON.stringify(message));
    }
    catch { /* private mode */ }
    try {
        const channel = new BroadcastChannel(BUS);
        channel.postMessage(message);
        channel.close();
    }
    catch { /* storage event fallback */ }
}
export function useAdminIdleSession(active: boolean, csrf: string, info: AdminSessionInfo | undefined, onEnd: (reason: string) => void) {
    const end = useRef(onEnd);
    end.current = onEnd;
    useEffect(() => {
        if (!active || !csrf || !info)
            return;
        let done = false, pending = false, checking = false, lastSent = 0;
        const remaining = (data: AdminSessionInfo) => Math.max(0, Math.min(LIMIT, data.expiresAt - data.serverNow));
        let deadline = Date.now() + remaining(info);
        const cleanup: (() => void)[] = [], seen = new WeakSet<Document>();
        const finish = (reason: string, broadcast = false) => { if (done)
            return; done = true; if (broadcast)
            announceAdminSession('logout', info.syncId); end.current(reason); };
        const receive = (message: Message) => {
            if (!message || typeof message.syncId !== 'string')
                return;
            if (message.type === 'login' && message.syncId !== info.syncId) {
                finish('Se inició otra sesión. Iniciá sesión nuevamente.');
                return;
            }
            if (message.syncId !== info.syncId)
                return;
            if (message.type === 'logout')
                finish('Sesión cerrada en otra pestaña. Iniciá sesión nuevamente.');
            if (message.type === 'activity' && Number.isFinite(message.expiresAt) && Number.isFinite(message.serverNow))
                deadline = Math.max(deadline, Date.now() + remaining(message as AdminSessionInfo));
        };
        const storage = (event: StorageEvent) => { if (event.key === BUS && event.newValue)
            try {
                receive(JSON.parse(event.newValue));
            }
            catch { } };
        window.addEventListener('storage', storage);
        cleanup.push(() => window.removeEventListener('storage', storage));
        try {
            const channel = new BroadcastChannel(BUS);
            channel.onmessage = e => receive(e.data);
            cleanup.push(() => channel.close());
        }
        catch { }
        const interaction = (event: Event) => {
            if (done || !event.isTrusted || pending || Date.now() - lastSent < 1000)
                return;
            lastSent = Date.now();
            pending = true;
            void fetch('/api/control/activity', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' })
                .then(async (r) => {
                if (r.status === 401 || r.status === 403) {
                    finish('Tu sesión venció o cambió. Iniciá sesión nuevamente.', true);
                    return;
                }
                if (!r.ok)
                    return;
                const data: AdminSessionInfo = await r.json();
                if (done)
                    return;
                if (data.syncId !== info.syncId) {
                    finish('Tu sesión cambió. Iniciá sesión nuevamente.');
                    return;
                }
                deadline = Date.now() + remaining(data);
                announceAdminSession('activity', info.syncId, data);
            }).catch(() => { }).finally(() => { pending = false; });
        };
        const attach = (doc: Document) => {
            if (seen.has(doc))
                return;
            seen.add(doc);
            for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'click']) {
                doc.addEventListener(type, interaction, { capture: true, passive: true });
                cleanup.push(() => doc.removeEventListener(type, interaction, true));
            }
            const frames = () => doc.querySelectorAll('iframe').forEach(frame => { try {
                if (frame.contentDocument)
                    attach(frame.contentDocument);
            }
            catch { /* cross-origin frame cannot claim admin activity */ } });
            const loaded = (event: Event) => { if ((event.target as HTMLElement)?.tagName === 'IFRAME')
                frames(); };
            doc.addEventListener('load', loaded, true);
            cleanup.push(() => doc.removeEventListener('load', loaded, true));
            const observer = new MutationObserver(frames);
            observer.observe(doc.documentElement, { childList: true, subtree: true });
            cleanup.push(() => observer.disconnect());
            frames();
        };
        attach(document);
        const timer = setInterval(() => {
            if (done || checking || Date.now() < deadline)
                return;
            // Another tab may have renewed the shared session while this tab slept.
            // GET only verifies: it NEVER records activity or renews server expiry.
            checking = true;
            void fetch('/api/control/session', { credentials: 'same-origin' }).then(async (r) => {
                if (done)
                    return;
                if (r.status === 401) {
                    finish('Sesión vencida por 5 minutos sin actividad. Iniciá sesión nuevamente.', true);
                    return;
                }
                if (!r.ok) {
                    finish('No se pudo verificar tu sesión. Iniciá sesión nuevamente.');
                    return;
                }
                const next: AdminSessionInfo = await r.json();
                if (next.syncId !== info.syncId) {
                    finish('Tu sesión cambió. Iniciá sesión nuevamente.');
                    return;
                }
                deadline = Date.now() + remaining(next);
                if (deadline <= Date.now())
                    finish('Sesión vencida. Iniciá sesión nuevamente.', true);
            }).catch(() => finish('Sesión sin verificar. Iniciá sesión nuevamente.')).finally(() => { checking = false; });
        }, 500);
        return () => { done = true; clearInterval(timer); cleanup.forEach(fn => fn()); };
    }, [active, csrf, info?.syncId]);
}
