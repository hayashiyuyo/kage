/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Per-task-type handlers. Mirrors the Tasks module in ./index.js,
 * minus the DOM render/dashboard concerns. Phases 3-4 ported here.
 *
 * Each handler is async and resolves when the task either completes
 * (target reached → finish()) or fails (skipped/timeout → failTask()).
 */

import { Logger } from "@utils/Logger";
import type { PluginNative } from "@utils/types";

import type { Patcher } from "./patcher";
import { settings } from "./settings";
import type { Traffic } from "./traffic";
import type { DetectedTask, FakeGame, OrionRuntime, Quest, Stores, TaskInfo, TaskType } from "./types";
import { debug, rnd, sanitize, sleep, trafficMetadataSealed } from "./util";

const logger = new Logger("OrionQuests");

// Discord renderer CSP blocks connect-src to *.discordsays.com. The bypass
// routes the discordsays POSTs through Vencord's main process via IPC, where
// Node fetch runs without CSP restrictions.
const Native = VencordNative.pluginHelpers.OrionQuests as PluginNative<typeof import("./native")>;

const HEARTBEAT_EVT = "QUESTS_SEND_HEARTBEAT_SUCCESS";
const MAX_TIME = 25 * 60 * 1000; // 25 minutes per task
const HEARTBEAT_GRACE = 90 * 1000; // GAME/STREAM: give up if Discord sends no heartbeat
const MAX_TASK_FAILURES = 5;

// blacklisted quest known to break enrollment
const BLACKLISTED_QUEST_ID = "1412491570820812933";

export interface TaskCallbacks {
    onProgress: (id: string, info: { name: string; type: TaskType; cur: number; max: number; status: string; actionRequired?: string | null; reason?: string | null; }) => void;
    onComplete: (q: Quest, t: TaskInfo) => Promise<void>;
}

export class TaskRunner {
    public skipped = new Set<string>();
    /**
     * Quests skipped only because the achievement bypass was switched off. A refusal
     * to act, not a quest that can't be done. Tracked apart from `skipped` so turning
     * the setting on can put them back in play. See retryConsentSkipped().
     */
    public consentSkipped = new Set<string>();
    /**
     * Why the last bypass attempt gave up, so the ACHIEVEMENT handler can put a real reason
     * on the failed row instead of "Cannot auto-complete". Reset at the start of every attempt.
     */
    private lastBypassFailure: string | null = null;
    private stores: Stores;
    private traffic: Traffic;
    private patcher: Patcher;
    private runtime: OrionRuntime;
    private cb: TaskCallbacks;
    /**
     * Real getStreamerActiveStreamMetadata, stashed once like Patcher does with RunStore.
     * May legitimately be undefined on builds that don't expose it, see the restore in generic().
     */
    private streamReal: any;
    private streamSpoofs = 0;

    constructor(stores: Stores, traffic: Traffic, patcher: Patcher, runtime: OrionRuntime, cb: TaskCallbacks) {
        this.stores = stores;
        this.traffic = traffic;
        this.patcher = patcher;
        this.runtime = runtime;
        this.cb = cb;
        this.streamReal = stores.StreamStore?.getStreamerActiveStreamMetadata;
    }

    /**
     * Newer quest configs (taskConfigV2) carry the app per task as tasks[key].applications[];
     * older ones had a single config.application.id. A GAME quest built with the wrong id
     * produces a fake process Discord can't match to the quest, so it never schedules a
     * heartbeat (issue #43).
     */
    appIdFor(cfg: any, keyName: string, legacyAppId?: string): string | null {
        return cfg?.tasks?.[keyName]?.applications?.[0]?.id ?? legacyAppId ?? null;
    }

    /**
     * userStatus.progress is a plain object over REST, but dispatched payloads go through the
     * client's own transform first, so the shape isn't ours to assume. Defensive: if it ever
     * arrives as a Map, indexing with [] would read undefined and silently look like
     * "no progress".
     */
    readProgress(userStatus: any, key: string): number {
        const p = userStatus?.progress;
        const entry = p instanceof Map ? p.get(key) : p?.[key];
        return entry?.value ?? userStatus?.streamProgressSeconds ?? 0;
    }

    /**
     * Detect task type from quest config.
     *
     * The exact keys come first and the loose prefixes last, and that order is the whole
     * point. This used to test `k.includes("PLAY")` before anything else, and
     * "PLAY_ACTIVITY".includes("PLAY") is true, so every activity quest was routed to the GAME
     * handler: it injected a fake process and then waited for heartbeats Discord does not send
     * for an activity task, so the quest never finished and the ACTIVITY handler was
     * unreachable for its own quest type. Verified against a live client.
     *
     * The prefix entries still catch platform variants (PLAY_ON_XBOX, WATCH_VIDEO_ON_MOBILE)
     * and anything new Discord adds under the same families.
     */
    detectType(cfg: any, applicationId?: string): DetectedTask | null {
        const taskKeys = Object.keys(cfg.tasks);
        const typeMap: Array<{ match: (k: string) => boolean; type: TaskType; }> = [
            { match: k => k === "ACHIEVEMENT_IN_ACTIVITY", type: "ACHIEVEMENT" },
            { match: k => k === "PLAY_ACTIVITY", type: "ACTIVITY" },
            { match: k => k.startsWith("STREAM"), type: "STREAM" },
            { match: k => k.includes("VIDEO"), type: "WATCH_VIDEO" },
            { match: k => k.startsWith("PLAY"), type: "GAME" },
            { match: k => k.includes("ACTIVITY"), type: "ACTIVITY" },
        ];
        for (const { match, type } of typeMap) {
            const keyName = taskKeys.find(match);
            if (keyName) {
                return {
                    type, keyName,
                    target: cfg.tasks[keyName]?.target ?? 0,
                    appId: this.appIdFor(cfg, keyName, applicationId),
                };
            }
        }
        if (applicationId) {
            return {
                type: "GAME", keyName: "PLAY_ON_DESKTOP",
                target: cfg.tasks[taskKeys[0]]?.target ?? 0,
                appId: applicationId,
            };
        }
        return null;
    }

    /** Pull real exe metadata from Discord's app registry; falls back to synthetic paths. */
    async fetchGameData(appId: string | number, appName: string): Promise<any> {
        try {
            const res = await this.stores.API.get({ url: `/applications/public?application_ids=${appId}` });
            const appData = res?.body?.[0];
            const exeEntry = appData?.executables?.find((x: any) => x.os === "win32");
            const rawExe = exeEntry ? exeEntry.name.replace(">", "") : `${sanitize(appName)}.exe`;
            const cleanName = sanitize(appData?.name || appName);
            return {
                name: appData?.name || appName,
                icon: appData?.icon,
                exeName: rawExe,
                cmdLine: `C:\\Program Files\\${cleanName}\\${rawExe}`,
                exePath: `c:/program files/${cleanName.toLowerCase()}/${rawExe}`,
                id: appId,
            };
        } catch (e: any) {
            debug(logger, `[FetchGame] Fallback for ${appName}: ${e?.message ?? e}`);
            const cleanName = sanitize(appName);
            const safeExe = `${cleanName.replace(/\s+/g, "")}.exe`;
            return {
                name: appName, exeName: safeExe,
                cmdLine: `C:\\Program Files\\${cleanName}\\${safeExe}`,
                exePath: `c:/program files/${cleanName.toLowerCase()}/${safeExe}`,
                id: appId,
            };
        }
    }

    /**
     * Claim a completed quest's reward.
     *
     * Body shaped after Discord's own claim action, which sends
     * `{platform, location, is_targeted, metadata_sealed, traffic_metadata_sealed}` and
     * nothing else. Two differences used to be visible on every claim: Orion added
     * `metadata_raw` and `traffic_metadata_raw`, which Discord never sends, and it nulled
     * `traffic_metadata_sealed` even though the value is sitting on the quest record.
     */
    async claimReward(questId: string): Promise<any> {
        return this.stores.API.post({
            url: `/quests/${questId}/claim-reward`,
            body: {
                platform: 0,
                location: 11,
                is_targeted: false,
                metadata_sealed: null,
                traffic_metadata_sealed: trafficMetadataSealed(this.stores.QuestStore, questId),
            },
        });
    }

    failTask(q: Quest, t: TaskInfo, reason: string): void {
        this.cb.onProgress(q.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "FAILED", reason });
        logger.error(`[Task] Aborted "${t.name}": ${reason}`);
        this.skipped.add(q.id);
    }

    /** WATCH_VIDEO: send fake video-progress timestamps until Discord marks the quest done. */
    async VIDEO(q: Quest, t: TaskInfo, s: any): Promise<void> {
        let cur: number = s?.progress?.[t.keyName]?.value ?? s?.progress?.[t.type]?.value ?? 0;
        let failCount = 0;

        this.cb.onProgress(q.id, { name: t.name, type: "WATCH_VIDEO", cur, max: t.target, status: "RUNNING" });

        const startTime = Date.now();

        // No synthetic first ping. It used to fire 200-350ms in with a timestamp of
        // 0.200-0.250, which meant every video quest from every user opened with a value
        // inside the same 50ms window. A real player reports its first tick on its own
        // cadence, so the loop below is left to send it.

        while (cur < t.target && this.runtime.running) {
            // Match Discord's native player cadence. A shorter interval buys nothing:
            // `cur` advances by real elapsed time below, so the quest still takes `target`
            // seconds of wall clock either way, and halving the delay only doubles the
            // number of requests. Measured: 68s target finished in 73s at 18 requests.
            const delayMs = rnd(7000, 9500);
            await sleep(delayMs);
            const elapsedSec = (delayMs / 1000) + (Math.random() * 0.02 - 0.01);
            cur += elapsedSec;
            const payloadTs = Number(Math.min(t.target, cur).toFixed(6));

            try {
                const r: any = await this.traffic.enqueue(`/quests/${q.id}/video-progress`, { timestamp: payloadTs });
                const serverVal: number | undefined = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.WATCH_VIDEO?.value;
                if (serverVal !== undefined && serverVal > cur) cur = Math.min(t.target, serverVal);
                if (r?.body?.completed_at) break;
                failCount = 0;
            } catch (e: any) {
                failCount++;
                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                    logger.warn(`[Task] Video quest unavailable (HTTP ${e.status}). Skipping.`);
                    return this.failTask(q, t, `Client Error ${e.status}`);
                }
                if (failCount >= MAX_TASK_FAILURES) {
                    return this.failTask(q, t, "Too many network failures");
                }
            }
            this.cb.onProgress(q.id, { name: t.name, type: "WATCH_VIDEO", cur, max: t.target, status: "RUNNING" });
            if (Date.now() - startTime > MAX_TIME) {
                return this.failTask(q, t, "Timeout exceeded");
            }
        }
        if (this.runtime.running) await this.cb.onComplete(q, t);
    }

    /** GAME / STREAM share an injection path: fake process + heartbeat subscription. */
    async generic(q: Quest, t: TaskInfo, type: TaskType, fallbackKey: string): Promise<void> {
        if (!this.runtime.running) return;
        // Prefer the key detected from the quest config. detectType matches task keys by
        // substring, so a renamed variant (a PLAY_ON_DESKTOP_V2, say) still resolves, but
        // reading progress under a hardcoded legacy name would return undefined and pin the
        // task at 0 until the safety timer kills it.
        const key = t.keyName || fallbackKey;
        const gameData = await this.fetchGameData(t.appId, t.name);

        return new Promise<void>(resolve => {
            const pid = rnd(2500, 12500) * 4; // multiples of 4 (Windows NT kernel alignment)
            const game: FakeGame = {
                id: gameData.id,
                name: gameData.name,
                icon: gameData.icon,
                pid,
                pidPath: [pid],
                processName: gameData.name,
                start: Date.now(),
                exeName: gameData.exeName,
                exePath: gameData.exePath,
                cmdLine: gameData.cmdLine,
                executables: [{ os: "win32", name: gameData.exeName, is_launcher: false }],
                windowHandle: 0, fullscreenType: 0, overlay: true, sandboxed: false,
                hidden: false, isLauncher: false,
            };

            let cleanupHook: () => void;
            let cleaned = false;
            let safetyTimer: number | undefined;
            let watchdogTimer: number | undefined;
            let beats = 0;

            if (type === "STREAM") {
                // Restore from the original captured in the constructor, never from whatever is
                // installed now: with concurrency > 1 a second STREAM task would otherwise stash
                // the first task's spoof and "restore" that, leaving the store patched after the
                // engine stops. Refcounted so the last task out puts the real method back, and
                // it restores even when the original was undefined, since assigning undefined
                // back is the correct revert (same reasoning as index.js).
                if (this.stores.StreamStore) {
                    this.streamSpoofs++;
                    this.stores.StreamStore.getStreamerActiveStreamMetadata = () => ({
                        id: gameData.id, pid, sourceName: gameData.name,
                    });
                }
                cleanupHook = () => {
                    if (this.stores.StreamStore && this.streamSpoofs > 0 && --this.streamSpoofs === 0) {
                        this.stores.StreamStore.getStreamerActiveStreamMetadata = this.streamReal;
                    }
                };
            } else {
                this.patcher.add(game);
                cleanupHook = () => this.patcher.remove(game);
            }

            // Seed from progress the server already holds. Painting 0 here made a resumed
            // quest look like it had restarted from scratch until the next heartbeat
            // (~30s later) corrected it.
            const seeded = this.readProgress(q.userStatus, key);
            this.cb.onProgress(q.id, { name: t.name, type, cur: seeded, max: t.target, status: "RUNNING" });
            logger.info(`[Task] Started ${type}: ${gameData.name}`);

            const finish = () => {
                if (cleaned) return;
                cleaned = true;
                clearTimeout(safetyTimer);
                clearTimeout(watchdogTimer);
                try { cleanupHook(); } catch (e: any) { debug(logger, `[Task] Cleanup: ${e?.message}`); }
                try { this.stores.Dispatcher?.unsubscribe(HEARTBEAT_EVT, check); } catch (e: any) { debug(logger, `[Dispatcher] Unsubscribe failed: ${e?.message}`); }
                this.runtime.cleanups.delete(abort);
            };

            // What shutdown runs. finish() alone tears down the timers that would otherwise have
            // resolved this promise, so registering it bare left the task pending forever: the
            // cycle loop stayed parked on Promise.all and startOrion never returned. Kept separate
            // from finish() so the completion path can still wait for onComplete (auto-claim)
            // before resolving.
            const abort = () => { finish(); resolve(); };

            safetyTimer = setTimeout(() => {
                if (this.runtime.running) this.failTask(q, t, "Timeout exceeded (25m)");
                finish();
                resolve();
            }, MAX_TIME) as unknown as number;

            // Discord drives these quests: it sends /quests/{id}/heartbeat itself while it
            // believes the game runs, and we only read the replies. If it never accepts the
            // injected process, no heartbeat ever arrives and the task would sit "RUNNING"
            // for the full 25 minutes with nothing happening. Give up after 90s (3 missed
            // beats at the usual ~30s cadence) and say why.
            // Re-armed on every beat rather than checked once, so it also catches a quest that
            // beats a few times and then goes silent. A one-shot `beats > 0` test would let that
            // sit RUNNING for the full 25 minutes with nothing actually happening.
            const armWatchdog = () => {
                clearTimeout(watchdogTimer);
                watchdogTimer = setTimeout(() => {
                    if (cleaned || !this.runtime.running) return;
                    logger.error(beats === 0
                        ? `[Task] Discord never reported progress for "${t.name}". It is not accepting the injected process on this client, so there is nothing to wait for.`
                        : `[Task] Discord stopped reporting progress for "${t.name}" after ${beats} update(s). Giving up instead of idling.`);
                    this.failTask(q, t, "No heartbeat from Discord");
                    finish();
                    resolve();
                }, HEARTBEAT_GRACE) as unknown as number;
            };
            armWatchdog();

            const check = (d: any) => {
                if (!this.runtime.running) { finish(); resolve(); return; }
                if (d?.questId !== q.id) return;
                beats++;
                armWatchdog();
                const prog = this.readProgress(d.userStatus, key);
                this.cb.onProgress(q.id, { name: t.name, type, cur: prog, max: t.target, status: "RUNNING" });
                if (prog >= t.target) {
                    finish();
                    this.cb.onComplete(q, t).finally(() => resolve());
                }
            };

            this.stores.Dispatcher?.subscribe(HEARTBEAT_EVT, check);
            this.runtime.cleanups.add(abort);
        });
    }

    GAME(q: Quest, t: TaskInfo): Promise<void> { return this.generic(q, t, "GAME", "PLAY_ON_DESKTOP"); }
    STREAM(q: Quest, t: TaskInfo): Promise<void> { return this.generic(q, t, "STREAM", "STREAM_ON_DESKTOP"); }

    /** ACTIVITY: heartbeat against a voice channel to simulate participation. */
    async ACTIVITY(q: Quest, t: TaskInfo): Promise<void> {
        const key = this.streamKey();
        if (!key) return this.failTask(q, t, "No voice channel found");
        // Discord's own heartbeat always carries application_id. Sending only stream_key and
        // terminal made every Orion beat structurally different from a real one.
        const beat = { stream_key: key, application_id: String(t.appId || ""), terminal: false };
        let cur = 0;
        let failCount = 0;
        let stalledBeats = 0;
        this.cb.onProgress(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
        const startTime = Date.now();

        while (cur < t.target && this.runtime.running) {
            try {
                const r: any = await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, beat);
                const reported = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.PLAY_ACTIVITY?.value;
                // Never invent progress. This used to fall back to `cur + 20`, so a server that
                // credited nothing still walked the counter to target and the quest was reported
                // complete on the strength of numbers Orion made up. Count the silent beats and
                // give up instead.
                if (typeof reported === "number") { cur = reported; stalledBeats = 0; }
                else if (++stalledBeats >= MAX_TASK_FAILURES) return this.failTask(q, t, "Discord credited no progress");
                this.cb.onProgress(q.id, { name: t.name, type: "ACTIVITY", cur, max: t.target, status: "RUNNING" });
                failCount = 0;
                if (cur >= t.target) {
                    try { await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, { ...beat, terminal: true }); }
                    catch (e: any) { debug(logger, `[ACTIVITY] Final heartbeat failed: ${e?.message}`); }
                    break;
                }
            } catch (e: any) {
                failCount++;
                if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                    logger.warn(`[Task] Activity quest unavailable (HTTP ${e.status}). Skipping.`);
                    return this.failTask(q, t, `Client Error ${e.status}`);
                }
                if (failCount >= MAX_TASK_FAILURES) return this.failTask(q, t, "Too many network failures");
            }
            if (Date.now() - startTime > MAX_TIME) return this.failTask(q, t, "Timeout exceeded");
            await sleep(rnd(19000, 22000));
        }
        if (this.runtime.running && cur >= t.target) await this.cb.onComplete(q, t);
    }

    /**
     * OAuth2 → discordsays.com bypass for ACHIEVEMENT_IN_ACTIVITY.
     * Discord trusts the activity backend to validate progress, so a forged
     * POST from an authorized session is accepted. Flow:
     *   1) /oauth2/authorize the quest's app (returns code in location URL)
     *   2) /applications/{appId}/proxy-tickets (returns proxy ticket)
     *   3) POST {appId}.discordsays.com/.proxy/acf/authorize {code} → DS token
     *   4) POST {appId}.discordsays.com/.proxy/acf/quest/progress {progress: target}
     *   5) /oauth2/tokens + DELETE to clean up the grant
     */
    async bypassAchievement(q: Quest, t: TaskInfo): Promise<boolean> {
        // taskConfigV2 moved the app off config.application and onto the task, so reading the
        // legacy field alone resolves null on every current quest and this bailed out before it
        // ever tried. t.appId already carries whatever appIdFor resolved, so prefer it and keep
        // the legacy read as the last fallback (issue #43).
        // TaskInfo.appId is string | number (it carries a `?? 0` fallback), and this value is
        // interpolated into discordsays URLs, so normalise to string once here.
        const appId = String(t.appId || q.config?.application?.id || "");
        this.lastBypassFailure = null;
        if (!appId) {
            this.lastBypassFailure = "this quest carries no application id, so there is nothing to authorize against";
            return false;
        }
        // Consent gate: the OAuth bypass authorizes a third-party app on the user's account.
        // It only runs when the user explicitly enabled it in settings (default off). The toggle
        // is the informed-consent gate and covers the non-interactive /orion start + Auto-Start paths.
        if (!settings.store.achievementBypass) {
            logger.info(`[Bypass] Achievement OAuth bypass is off in settings; skipping "${t.name}". Enable it in OrionQuests settings if you want it.`);
            return false;
        }
        // appId is interpolated straight into discordsays URLs. Refuse anything
        // non-numeric so a malformed/hostile id can't redirect the request elsewhere.
        if (!/^\d+$/.test(appId)) {
            logger.warn(`[Bypass] Refusing non-numeric appId "${appId}".`);
            return false;
        }

        // Snapshot the grants this app already has BEFORE we authorize, so cleanup
        // revokes only the grant we create and never one the user made themselves.
        // The snapshot is a precondition: if it fails we abort before authorizing, so we
        // never create a grant we can't later identify and revoke.
        let preGrantIds: Set<string> | undefined;
        try {
            const before: any = await this.stores.API.get({ url: "/oauth2/tokens" });
            preGrantIds = new Set((before?.body || []).filter((tk: any) => tk.application?.id === appId).map((tk: any) => tk.id));
        } catch (e: any) {
            logger.warn(`[Bypass] Couldn't snapshot existing grants; aborting so we never leave an un-revocable authorization: ${e?.message}`);
            return false;
        }

        try {
            logger.info(`[Bypass] Trying Discord Says auth flow for "${t.name}"...`);

            const authRes: any = await this.stores.API.post({
                url: "/oauth2/authorize",
                query: {
                    response_type: "code",
                    client_id: appId,
                    scope: "identify applications.commands applications.entitlements"
                },
                body: {
                    permissions: "0",
                    authorize: true,
                    integration_type: 1,
                    location_context: { guild_id: "10000", channel_id: "10000", channel_type: 10000 }
                }
            });
            const location: string | undefined = authRes?.body?.location;
            if (!location) throw new Error("no location in /oauth2/authorize response");
            const authCode = new URL(location).searchParams.get("code");
            if (!authCode) throw new Error("no code in authorize location");

            const ticketRes: any = await this.stores.API.post({ url: `/applications/${appId}/proxy-tickets`, body: {} });
            const proxyTicket: string | undefined = ticketRes?.body?.ticket;
            if (!proxyTicket) throw new Error("no proxy ticket");

            const referrer = `https://${appId}.discordsays.com/?instance_id=example-cl-instance&platform=desktop&discord_proxy_ticket=${encodeURIComponent(proxyTicket)}`;

            // CSP-exempt main-process fetch via the native module
            const dsAuthRes = await Native.discordsaysAuthorize({ appId, questId: q.id, authCode, referrer });
            if (!dsAuthRes.ok) throw new Error(`discordsays authorize ${dsAuthRes.status}`);
            let dsToken: string | undefined;
            try { dsToken = (JSON.parse(dsAuthRes.body) as { token?: string }).token; }
            catch { throw new Error("discordsays returned non-JSON: " + String(dsAuthRes.body).slice(0, 120)); }
            if (!dsToken) throw new Error("no discordsays token");

            const progRes = await Native.discordsaysProgress({ appId, questId: q.id, token: dsToken, target: t.target, referrer });
            if (!progRes.ok) throw new Error(`discordsays progress ${progRes.status}`);

            logger.info(`[Bypass] Success. "${t.name}" completed via Discord Says.`);
            return true;
        } catch (e: any) {
            const code = e?.body?.code;
            // 50165 = Cannot launch Age-Gated Activity: age-gated or delisted
            if (code === 50165) {
                this.lastBypassFailure = "the activity is age-gated or delisted, so Discord refuses the proxy ticket on this account";
                logger.warn(`[Bypass] "${t.name}" can't be launched (age-gated or delisted). Discord blocks the proxy ticket, so there is nothing we can do.`);
                return false;
            }
            const parts: string[] = [];
            if (e?.status) parts.push(`HTTP ${e.status}`);
            if (code) parts.push(`code ${code}`);
            if (e?.body?.message) parts.push(e.body.message);
            else if (e?.message) parts.push(e.message);
            else if (typeof e === "string") parts.push(e);
            else if (e) { try { parts.push(JSON.stringify(e).slice(0, 200)); } catch { parts.push(String(e)); } }
            this.lastBypassFailure = `the Discord Says bypass failed (${parts.join(", ") || "unknown error"})`;
            logger.warn(`[Bypass] Failed: ${parts.join(", ") || "unknown"}`);
            return false;
        } finally {
            // Revoke ONLY the grant we created, diffed against the pre-flow snapshot.
            // Runs whether progress succeeded or threw, so a failed bypass never leaves
            // the app authorized on the user's account.
            if (preGrantIds) {
                const snap = preGrantIds;
                try {
                    const after: any = await this.stores.API.get({ url: "/oauth2/tokens" });
                    const ours = (after?.body || []).filter((tk: any) => tk.application?.id === appId && !snap.has(tk.id));
                    for (const g of ours) await this.stores.API.del({ url: `/oauth2/tokens/${g.id}` });
                } catch (e: any) {
                    debug(logger, `[Bypass] Deauthorize cleanup non-fatal: ${e?.message}`);
                }
            }
        }
    }

    /**
     * ACHIEVEMENT_IN_ACTIVITY. Target is usually 1 (a milestone, not seconds).
     *   1) heartbeat spoof (works for some quests)
     *   2) discordsays OAuth bypass (silver bullet)
     *   3) skip on failure, with no 25-minute passive wait
     */
    async ACHIEVEMENT(q: Quest, t: TaskInfo): Promise<void> {
        this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur: 0, max: t.target, status: "RUNNING" });

        const key = this.streamKey();
        if (key) {
            const beat = { stream_key: key, application_id: String(t.appId || ""), terminal: false };
            let cur = 0;
            let failCount = 0;
            logger.info(`[Task] Attempting heartbeat spoofing for "${t.name}"...`);

            while (cur < t.target && this.runtime.running) {
                try {
                    const r: any = await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, beat);
                    cur = r?.body?.progress?.[t.keyName]?.value ?? r?.body?.progress?.ACHIEVEMENT_IN_ACTIVITY?.value ?? cur;
                    this.cb.onProgress(q.id, { name: t.name, type: "ACHIEVEMENT", cur, max: t.target, status: "RUNNING" });
                    failCount = 0;
                    if (cur >= t.target) {
                        try { await this.traffic.enqueue(`/quests/${q.id}/heartbeat`, { ...beat, terminal: true }); }
                        catch { /* noop */ }
                        break;
                    }
                } catch (e: any) {
                    failCount++;
                    if (e?.status && [400, 403, 404, 409, 410].includes(e.status)) {
                        logger.warn(`[Achievement] Heartbeat rejected (HTTP ${e.status}). Falling back to bypass.`);
                        break;
                    }
                    if (failCount >= MAX_TASK_FAILURES) {
                        logger.warn(`[Achievement] Too many failures. Falling back to bypass.`);
                        break;
                    }
                }
                await sleep(rnd(19000, 22000));
            }

            if (cur >= t.target && this.runtime.running) return this.cb.onComplete(q, t);
        }

        // heartbeat failed or skipped, so try the discordsays OAuth bypass
        if (!this.runtime.running) return;
        const bypassed = await this.bypassAchievement(q, t);
        if (bypassed) return this.cb.onComplete(q, t);

        if (!this.runtime.running) return;

        // A bypass that never ran because the consent toggle is off is not the same as one
        // that ran and failed. Recorded separately so switching the toggle on returns the
        // quest to the queue. Otherwise it stays in `skipped` for the life of the run and
        // the setting looks like it did nothing.
        if (!settings.store.achievementBypass) {
            this.consentSkipped.add(q.id);
            return this.failTask(q, t, "Achievement bypass is off in settings");
        }

        // both auto-paths failed: skip the quest. no more 25-min passive wait.
        // The bypass records why it gave up, so pass that on instead of a bare
        // "Cannot auto-complete", which left the status with nothing to act on.
        logger.warn(`[Task] Skipping "${t.name}". No auto-completion path worked (heartbeat rejected, bypass blocked). Likely age-gated/delisted on your account.`);
        return this.failTask(q, t, this.lastBypassFailure ?? "no auto-completion path worked");
    }

    /**
     * Return quests that were skipped only for want of consent, so the next cycle picks them
     * up again. Called when the achievement bypass is switched on while the engine runs.
     */
    retryConsentSkipped(): number {
        let restored = 0;
        for (const id of this.consentSkipped) if (this.skipped.delete(id)) restored++;
        this.consentSkipped.clear();
        return restored;
    }

    /**
     * Build a stream key in the shape Discord's own encoder produces.
     *
     * Discord joins the parts with a colon and the trailing component is the stream owner:
     *   call:<channelId>:<ownerId>
     *   guild:<guildId>:<channelId>:<ownerId>
     * and its decoder destructures them back in exactly that order.
     *
     * Two things used to be wrong here. The owner slot carried `rnd(1000, 9999)`, so every
     * heartbeat body advertised a four digit number where a user snowflake belongs, and a
     * guild voice channel was still encoded with the `call:` prefix, which decodes as a DM
     * channel id. Both are visible in the request body on every beat.
     */
    private streamKey(): string | null {
        try {
            const ownerId = this.stores.UserStore?.getCurrentUser?.()?.id;
            if (!ownerId) return null;

            const dmChan = this.stores.ChanStore?.getSortedPrivateChannels()?.[0]?.id;
            if (dmChan) return `call:${dmChan}:${ownerId}`;

            const guilds = this.stores.GuildChanStore?.getAllGuilds() ?? {};
            for (const g of Object.values<any>(guilds)) {
                const voiceChan = g?.VOCAL?.[0]?.channel;
                if (voiceChan?.id) {
                    const guildId = voiceChan.guild_id ?? g?.id;
                    if (guildId) return `guild:${guildId}:${voiceChan.id}:${ownerId}`;
                }
            }
            return null;
        } catch (e: any) {
            debug(logger, `[Task] Stream key lookup error: ${e?.message}`);
            return null;
        }
    }

    /** Filter quests for execution: exclude completed, expired, blacklisted, and previously-skipped. */
    activeQuests(quests: Quest[]): Quest[] {
        const now = Date.now();
        return quests.filter(q =>
            !q.userStatus?.completedAt
            && new Date(q.config?.expiresAt ?? 0).getTime() > now
            && q.id !== BLACKLISTED_QUEST_ID
            && !this.skipped.has(q.id)
        );
    }
}

export { BLACKLISTED_QUEST_ID, MAX_TASK_FAILURES, MAX_TIME };
