/*
 * OrionQuests, a Vencord userplugin
 * Copyright (c) 2026 nyxxbit
 * SPDX-License-Identifier: MIT
 */

import type { Logger } from "@utils/Logger";

import { settings } from "./settings";

/**
 * Debug output, gated by the verboseLogging setting.
 *
 * Vencord's Logger.debug always calls console.debug, and browsers hide that level
 * unless the console is switched to Verbose, so the setting had nothing to switch:
 * every debug line was emitted either way, and whether you saw it depended on a
 * DevTools filter. With the setting on these go out at info level, where they show
 * by default; with it off the behaviour is unchanged.
 */
export function debug(logger: Logger, ...args: any[]): void {
    if (settings.store.verboseLogging) logger.info(...args);
    else logger.debug(...args);
}

export const sleep = (ms: number): Promise<void> =>
    new Promise(r => setTimeout(r, ms));

export const rnd = (min: number, max: number): number =>
    Math.floor(Math.random() * (max - min + 1)) + min;

export function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9 ]/g, "").trim().replace(/\s+/g, " ");
}

/**
 * The server-sealed attribution blob Discord echoes back when enrolling in or claiming a
 * quest, read off the quest record the same way Discord's own helper does.
 *
 * The server issues it per quest and hands it to the client in the quest list, and the
 * client returns it unmodified. Orion sent neither field, so every enrollment and every
 * claim it made was missing something present on every request the real client sends.
 * Nothing here is forged: this is the server's own value going back where it came from.
 *
 * Returns null when the quest is unknown or predates the field, which is also what
 * Discord sends in that case.
 */
export function trafficMetadataSealed(questStore: any, questId: string): string | null {
    try {
        return questStore?.getQuest?.(questId)?.trafficMetadataSealed ?? null;
    } catch {
        return null;
    }
}

// Discord's quest reward type → human label
export const REWARD_LABELS: Record<number, string> = {
    1: "In-Game Item",
    3: "Avatar Decoration",
    4: "Orbs",
};
