/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 *
 * Main orchestration. Loads stores via Vencord's webpack helpers,
 * runs the cycle loop that JIT-enrolls and dispatches handlers per
 * task type, and surfaces progress through the dashboard registry.
 */

import { SettingsStore } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { findByProps, findStore } from "@webpack";
import { FluxDispatcher, RestAPI } from "@webpack/common";

import { setAchievementBypassHook } from "./hooks";
import { Patcher } from "./patcher";
import { settings } from "./settings";
import { TaskRunner } from "./tasks";
import { isSkippableQuest, Traffic } from "./traffic";
import type { OrionRuntime, Quest, Stores, TaskInfo, TaskType } from "./types";
import { debug, rnd, sleep, trafficMetadataSealed } from "./util";

const logger = new Logger("OrionQuests");

// GAME/STREAM quests need the desktop process-injection path, so we skip them
// silently when running in a browser context. Use Vencord's build-time globals
// (IS_DISCORD_DESKTOP / IS_VESKTOP) instead of probing window.DiscordNative:
// the preload global isn't reliably visible from the plugin's execution context,
// which made the desktop build wrongly skip game quests (issue #35).
const IS_DESKTOP = IS_DISCORD_DESKTOP || IS_VESKTOP;

// Tiny Web Audio synth that mirrors the userscript's Sound module. 'tick'
// fires after each quest completes; 'done' fires when the whole queue is
// finished. Soft-fails on environments without AudioContext.
const Sound = {
    play(type: "tick" | "done"): void {
        if (!settings.store.playSound) return;
        try {
            const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
            if (!Ctx) return;
            const ctx = new Ctx();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.type = "sine";
            const t0 = ctx.currentTime;
            if (type === "done") {
                o.frequency.setValueAtTime(523.25, t0);
                o.frequency.setValueAtTime(659.25, t0 + 0.12);
                o.frequency.setValueAtTime(783.99, t0 + 0.24);
                g.gain.setValueAtTime(0.55, t0);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
                o.start(t0); o.stop(t0 + 0.6);
            } else {
                o.frequency.value = 880;
                g.gain.setValueAtTime(0.45, t0);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
                o.start(t0); o.stop(t0 + 0.2);
            }
        } catch (_) { /* audio unavailable, ignore */ }
    }
};

// Status of a task as surfaced to UI consumers (dashboard, slash commands).
export interface DashboardEntry {
    id: string;
    name: string;
    type: TaskType;
    cur: number;
    max: number;
    status: string;
    claimable?: boolean;
    actionRequired?: string | null;
    /**
     * Why a task ended the way it did. Only set for FAILED, where a bare status is useless:
     * the reason already existed, went into the log, and was dropped before it reached
     * `/orion status`, so anyone reading the status saw `FAILED (0%)` and had nothing to act on.
     */
    reason?: string | null;
}

const RUNTIME: OrionRuntime = {
    running: false,
    cleanups: new Set<() => void>(),
    skipped: new Set<string>(),
};

const dashboard = new Map<string, DashboardEntry>();
const dashboardListeners = new Set<() => void>();
let stores: Stores | null = null;
let patcher: Patcher | null = null;

let traffic: Traffic | null = null;
let tasks: TaskRunner | null = null;

/**
 * hideActivity is read live, but nothing re-read it between task boundaries: suppression is
 * recomputed only when a fake game is added or removed, and a game quest holds one for up to
 * 25 minutes. Vencord notifies us the moment the user clicks instead. The handler is
 * module-level so stopOrion can pass the same reference back to remove it.
 *
 * The path is resolved on use, never at module load: definePluginSettings leaves pluginName
 * empty and Vencord fills it in when it initialises the plugin, so a path built up here would
 * read "plugins..hideActivity" and the listener would never fire.
 */
const hideActivityPath = () => `plugins.${settings.pluginName}.hideActivity`;
const onHideActivityChanged = () => patcher?.syncPresenceSuppression();

/** Public read access for the React dashboard component. */
export function subscribeDashboard(fn: () => void): () => void {
    dashboardListeners.add(fn);
    return () => dashboardListeners.delete(fn);
}
export function readDashboard(): DashboardEntry[] {
    return Array.from(dashboard.values());
}
/** Single source of truth for "is the engine up". index.tsx used to keep its own flag. */
export function isEngineRunning(): boolean {
    return RUNTIME.running;
}
function emitDashboard(): void {
    for (const fn of dashboardListeners) {
        try { fn(); } catch (e: any) { debug(logger, `[UI] listener threw: ${e?.message}`); }
    }
}
function setEntry(id: string, partial: Partial<DashboardEntry> & { name: string; type: TaskType; cur: number; max: number; status: string; }): void {
    // A stopped engine must never leave an in-flight status behind: mainLoop skips quests
    // whose entry reads RUNNING, so a late poll landing after shutdown would lock that
    // quest out of every future start. Terminal updates (COMPLETED/CLAIMED/FAILED) still
    // get through, since those are results worth keeping.
    if (!RUNTIME.running && (partial.status === "RUNNING" || partial.status === "QUEUE")) return;

    const prev = dashboard.get(id) ?? { id, claimable: false, actionRequired: null, reason: null } as DashboardEntry;
    // Entries merge over the previous value, so a reason from an earlier failure would ride
    // along on the row after a retry and explain a state the quest is no longer in. It belongs
    // to FAILED only, so anything else clears it unless the caller passes one explicitly.
    const carried = partial.status === "FAILED" || "reason" in partial ? {} : { reason: null };
    dashboard.set(id, { ...prev, id, ...partial, ...carried });
    emitDashboard();
}
function removeEntry(id: string): void {
    dashboard.delete(id);
    emitDashboard();
}

let questStore: any = null;

/**
 * QuestStore, resolved independently of the engine's lifetime. The enrollment watcher in
 * index.tsx needs the store while the engine is down, and the display name has been both
 * "QuestStore" and "QuestsStore" across builds, so the fallback lives in one place instead
 * of being copied into every caller. Resolved on first use, not at module load: findStore
 * walks the webpack cache, which is not populated when the plugin module is evaluated.
 */
export function getQuestStore(): any {
    if (!questStore) questStore = findStore("QuestStore") || findStore("QuestsStore");
    return questStore;
}

/** Current quest list, for callers that only want to read it (the watcher). */
export function listQuests(): Quest[] {
    return getQuestsArray(getQuestStore());
}

function loadStores(): Stores {
    const QuestStore = getQuestStore();
    const RunStore = findStore("RunningGameStore");
    const StreamStore = findStore("ApplicationStreamingStore");
    const ChanStore = findStore("ChannelStore");
    const GuildChanStore = findStore("GuildChannelStore");
    const UserStore = findStore("UserStore");
    const Dispatcher = (FluxDispatcher as any) || findByProps("dispatch", "subscribe", "flushWaitQueue");
    const API = (RestAPI as any) || findByProps("get", "post", "del");

    if (!QuestStore) throw new Error("QuestStore not found");
    if (!RunStore) throw new Error("RunningGameStore not found");
    if (!Dispatcher) throw new Error("FluxDispatcher not found");
    if (!API) throw new Error("RestAPI not found");

    if (!StreamStore) logger.warn("StreamStore not found, STREAM quests will be limited");
    if (!ChanStore) logger.warn("ChannelStore not found, ACTIVITY quests may not find a channel");
    if (!GuildChanStore) logger.warn("GuildChannelStore not found, ACTIVITY guild fallback unavailable");
    if (!UserStore) logger.warn("UserStore not found, STREAM and ACTIVITY quests cannot build a stream key");

    return { QuestStore, RunStore, StreamStore, ChanStore, GuildChanStore, UserStore, Dispatcher, API };
}

/**
 * When Discord has blocked quest enrollment for this account, as a Date, otherwise null.
 *
 * `QuestStore.questEnrollmentBlockedUntil` is populated from the same `/quests/@me` response
 * the client already fetches, so reading it costs nothing and adds no request. A block is the
 * clearest signal Discord gives that it has taken an interest in the account, and running on
 * through it is both futile and the worst thing to do about it.
 */
function enrollmentBlockedUntil(): Date | null {
    try {
        const raw = stores?.QuestStore?.questEnrollmentBlockedUntil;
        if (!raw) return null;
        const when = raw instanceof Date ? raw : new Date(raw);
        return isNaN(when.getTime()) || when.getTime() <= Date.now() ? null : when;
    } catch {
        return null;
    }
}

function getQuestsArray(questStore: any): Quest[] {
    const q = questStore?.quests;
    if (!q) return [];
    if (typeof q.values === "function") return Array.from(q.values()) as Quest[];
    if (Array.isArray(q)) return q as Quest[];
    return Object.values(q) as Quest[];
}

/** Run async tasks concurrently up to a specified limit, with stagger to avoid bursts. */
async function runConcurrent(taskFns: Array<() => Promise<any>>, limit: number): Promise<any[]> {
    const executing = new Set<Promise<any>>();
    for (const fn of taskFns) {
        if (!RUNTIME.running) break;
        const p = fn().finally(() => executing.delete(p));
        executing.add(p);
        await sleep(rnd(1500, 4000));
        if (executing.size >= limit) await Promise.race(executing);
    }
    return Promise.allSettled(executing);
}

async function onTaskComplete(q: Quest, t: TaskInfo): Promise<void> {
    setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED" });
    logger.info(`[Task] Completed "${t.name}"!`);
    Sound.play("tick");

    // browser notification
    try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Orion: Quest Completed", {
                body: t.name,
                tag: `orion-${q.id}`,
            });
        }
    } catch (e: any) { debug(logger, `[Notification] ${e?.message}`); }

    if (settings.store.tryToClaimReward && tasks) {
        try {
            await sleep(rnd(2500, 6000));
            if (!RUNTIME.running) return;
            const claimRes: any = await tasks.claimReward(q.id);
            if (claimRes?.body?.claimed_at) {
                logger.info(`[Claim] Reward for "${t.name}" claimed automatically!`);
                setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "CLAIMED" });
                setTimeout(() => removeEntry(q.id), 2000);
                return;
            }
        } catch (e: any) {
            const needsCaptcha = e?.body?.captcha_key || e?.body?.captcha_sitekey;
            if (needsCaptcha) {
                logger.warn(`[Claim] Captcha required for "${t.name}". Use Discord's UI button.`);
            } else {
                logger.error(`[Claim] Auto-claim failed for "${t.name}": ${e?.body?.message ?? e?.message}`);
            }
        }
    }

    setEntry(q.id, { name: t.name, type: t.type, cur: t.target, max: t.target, status: "COMPLETED", claimable: true });
}

async function mainLoop(): Promise<void> {
    let loopCount = 1;
    while (RUNTIME.running) {
        try {
            logger.info(`[Cycle] Starting loop #${loopCount}...`);

            // Discord tells the client when the account may not enroll in anything, and the
            // quest list carries the timestamp. Checked every cycle rather than once at start,
            // because the block can land mid-run, and continuing past it means hammering an
            // endpoint that is already refusing us.
            const blockedUntil = enrollmentBlockedUntil();
            if (blockedUntil) {
                logger.error(`[System] Discord has blocked quest enrollment on this account until ${blockedUntil.toLocaleString()}. Stopping instead of retrying.`);
                break;
            }

            const all = getQuestsArray(stores!.QuestStore);
            const active = tasks!.activeQuests(all);

            if (!active.length) {
                logger.info("[System] All available quests are completed!");
                Sound.play("done");
                break;
            }

            const queues: { video: Array<() => Promise<any>>; game: Array<() => Promise<any>>; } = { video: [], game: [] };

            for (const q of active) {
                try {
                    const cfg = q.config?.taskConfig ?? q.config?.taskConfigV2;
                    if (!cfg?.tasks || typeof cfg.tasks !== "object") {
                        logger.warn(`[Quest] ${q.id} has invalid task config. Skipping.`);
                        continue;
                    }
                    const detected = tasks!.detectType(cfg, q.config?.application?.id);
                    if (!detected) {
                        logger.warn(`[Quest] Unknown task type: ${q.config?.messages?.questName ?? q.id}`);
                        continue;
                    }
                    if (!IS_DESKTOP && (detected.type === "GAME" || detected.type === "STREAM")) {
                        logger.warn(`[Quest] "${q.config?.messages?.questName ?? q.id}" requires desktop app. Skipping.`);
                        continue;
                    }
                    const { type, keyName, target, appId } = detected;
                    if (target <= 0) {
                        logger.warn(`[Quest] Invalid target (${target}) for ${q.id}. Skipping.`);
                        continue;
                    }
                    // GAME/STREAM impersonate a specific application. Without a real id the fake
                    // process is unidentifiable and Discord silently never counts it, so skip loudly
                    // instead of running a task that can't finish (issue #43).
                    if ((type === "GAME" || type === "STREAM") && !appId) {
                        logger.warn(`[Quest] "${q.config?.messages?.questName ?? q.id}" has no application id in its config, so the game cannot be spoofed. Skipping.`);
                        // activeQuests() filters on the TaskRunner's set; RUNTIME.skipped alone is
                        // never read, so skipping there re-detects and re-warns every cycle forever.
                        RUNTIME.skipped.add(q.id);
                        tasks!.skipped.add(q.id);
                        continue;
                    }
                    const t: TaskInfo = {
                        id: q.id,
                        appId: appId ?? 0,
                        name: q.config?.messages?.questName ?? "Unknown Quest",
                        target, type, keyName,
                    };

                    // skip if already running
                    if (dashboard.get(q.id)?.status === "RUNNING") continue;

                    // Auto-enroll off means the user picks the quests: leave anything they
                    // haven't accepted untouched and park it instead of queuing it. activeQuests
                    // keeps unenrolled quests in the list, so the next cycle re-checks and queues
                    // this one the moment they accept it in Discord, without a restart.
                    if (!q.userStatus?.enrolledAt && !settings.store.autoEnroll) {
                        // announce the wait once, not on every rescan
                        if (dashboard.get(q.id)?.status !== "PENDING") {
                            logger.info(`[Enroll] Auto-enroll is off, waiting for you to accept "${t.name}" in Discord.`);
                        }
                        setEntry(t.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "PENDING", actionRequired: "ENROLL" });
                        continue;
                    }

                    // actionRequired is sticky across updates, so clear it explicitly: a quest
                    // parked on the last cycle and accepted since would otherwise keep telling
                    // the UI to ask for something the user already did.
                    setEntry(t.id, { name: t.name, type: t.type, cur: 0, max: t.target, status: "QUEUE", actionRequired: null });

                    const taskFn = async () => {
                        // JIT enrollment, only reached with auto-enroll on (the gate above
                        // returns first otherwise) or when the user enrolled themselves
                        if (!q.userStatus?.enrolledAt) {
                            logger.info(`[Enroll] Accepting quest: ${t.name}`);
                            try {
                                await traffic!.enqueue(`/quests/${q.id}/enroll`, {
                                    location: 11,
                                    is_targeted: false,
                                    metadata_sealed: null,
                                    traffic_metadata_sealed: trafficMetadataSealed(stores!.QuestStore, q.id),
                                });
                                await sleep(rnd(800, 1500));
                            } catch (e: any) {
                                // one definition of "this quest is gone", owned by traffic.ts
                                if (isSkippableQuest(e)) {
                                    RUNTIME.skipped.add(q.id);
                                    tasks!.skipped.add(q.id);
                                    logger.warn(`[Enroll] ${t.name} unavailable (${e.status}). Skipping.`);
                                } else {
                                    logger.error(`[Enroll] Failed for ${t.name}: ${e?.message}`);
                                }
                                return tasks!.failTask(q, t, "Enrollment failed");
                            }
                        }
                        if (type === "WATCH_VIDEO") return tasks!.VIDEO(q, t, q.userStatus);
                        if (type === "ACHIEVEMENT") return tasks!.ACHIEVEMENT(q, t);
                        if (type === "STREAM") return tasks!.STREAM(q, t);
                        if (type === "ACTIVITY") return tasks!.ACTIVITY(q, t);
                        return tasks!.GAME(q, t);
                    };

                    if (type === "WATCH_VIDEO") queues.video.push(taskFn);
                    else queues.game.push(taskFn);
                } catch (e: any) {
                    logger.error(`[Quest] Error processing ${q.id}: ${e?.message}`);
                }
            }

            const total = queues.video.length + queues.game.length;
            if (total > 0) {
                logger.info(`[Cycle] Processing: ${queues.video.length} videos, ${queues.game.length} games.`);
                const pGames = runConcurrent(queues.game, settings.store.gameConcurrency ?? 1);
                const pVideos = runConcurrent(queues.video, settings.store.videoConcurrency ?? 2);
                await Promise.all([pGames, pVideos]);
            } else {
                await sleep(rnd(4000, 6000));
            }

            if (!RUNTIME.running) break;
            logger.info(`[Cycle] Loop #${loopCount} complete. Waiting before rescan...`);
            await sleep(rnd(2500, 4500));
            loopCount++;
        } catch (e: any) {
            logger.error(`[Cycle] Error in loop #${loopCount}: ${e?.message ?? e}`);
            await sleep(3000);
            loopCount++;
        }
    }
}

export async function startOrion(): Promise<void> {
    if (RUNTIME.running) {
        logger.warn("Already running, ignoring start()");
        return;
    }
    RUNTIME.running = true;

    // Drop finished/aborted rows from earlier runs. Pruned here rather than on stop so results
    // stay readable after a run ends, but a fresh start never reports a previous session's tasks.
    for (const [id, e] of dashboard) {
        if (e.status !== "RUNNING" && e.status !== "QUEUE") dashboard.delete(id);
    }
    emitDashboard();

    logger.info("Starting OrionQuests");

    try {
        stores = loadStores();
        // pass a getter, not a snapshot: the setting is toggleable mid-run
        patcher = new Patcher(stores, () => !!settings.store.hideActivity);
        SettingsStore.addChangeListener(hideActivityPath(), onHideActivityChanged);
        traffic = new Traffic(stores.API, () => RUNTIME.running);
        tasks = new TaskRunner(stores, traffic, patcher, RUNTIME, {
            onProgress: (id, info) => setEntry(id, info),
            onComplete: onTaskComplete,
        });

        // Turning the achievement bypass on mid-run should reach the quests it already
        // refused, not just the ones detected after the flip.
        setAchievementBypassHook(enabled => {
            if (!enabled || !tasks) return;
            const restored = tasks.retryConsentSkipped();
            if (restored > 0) logger.info(`[Settings] Achievement bypass enabled, retrying ${restored} skipped quest(s) on the next cycle.`);
        });

        try {
            if (typeof Notification !== "undefined" && Notification.permission === "default") {
                Notification.requestPermission();
            }
        } catch (e: any) { debug(logger, `[Notification] permission request failed: ${e?.message}`); }

        await mainLoop();
    } catch (e: any) {
        logger.error("Fatal:", e);
        RUNTIME.running = false;
    } finally {
        // mainLoop exits when nothing left to do; teardown unconditionally
        stopOrion();
    }
}

export function stopOrion(): void {
    if (!RUNTIME.running && !patcher && !stores) return;
    RUNTIME.running = false;

    let failed = 0;
    for (const cleanup of RUNTIME.cleanups) {
        try { cleanup(); }
        catch (e: any) { failed++; logger.error("Cleanup function threw:", e); }
    }
    RUNTIME.cleanups.clear();

    // Detach before clean(): the listener holds the patcher, and a settings change arriving
    // after teardown would re-enter a torn-down engine.
    SettingsStore.removeChangeListener(hideActivityPath(), onHideActivityChanged);

    // Retire whatever was still in flight. Without this, a quest stopped part-way keeps a
    // RUNNING entry in the registry, mainLoop's "already running" guard skips it on every
    // later start, and the queue comes up empty while /orion status still reports it.
    // PENDING goes with them: unlike COMPLETED it is an instruction rather than a result, and
    // a stopped engine telling you to go accept a quest is telling you to do something that
    // will have no effect until you start it again.
    for (const [id, e] of dashboard) {
        if (e.status === "RUNNING" || e.status === "QUEUE" || e.status === "PENDING") {
            dashboard.set(id, { ...e, status: "STOPPED", actionRequired: null });
        }
    }
    emitDashboard();

    // Drop the settings bridge with everything else it points at. A hook holding a
    // torn-down TaskRunner is the same leak as any other module state outliving the engine.
    setAchievementBypassHook(null);

    try { patcher?.clean(); } catch (e: any) { logger.error("Patcher cleanup threw:", e); }
    patcher = null;
    stores = null;
    traffic = null;
    tasks = null;

    logger.info(`Stopped. ${failed > 0 ? `${failed} cleanup(s) threw, see errors above.` : "All cleanups flushed cleanly."}`);
}
