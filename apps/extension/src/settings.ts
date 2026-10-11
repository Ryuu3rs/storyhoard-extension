export type ReadingDirection = "ltr" | "rtl" | "vertical"
export type PageFit = "width" | "height" | "contain" | "original" | "actual"

export type OpenChapterIn = "reader" | "browser"

export type AppSettings = {
    autoAdd: boolean
    // Mark a chapter read as soon as you open it on the source site (not just in the AMR reader).
    // On by default so reading next-next-next on a site keeps your progress up to date; turn it off
    // to only record progress from the AMR reader or the on-page "Mark read" button. Only ever
    // ratchets progress forward, never backwards.
    markReadOnVisit: boolean
    // Follow a recognised reader site on its own, without waiting for the Track button, when its page is
    // detected on a site the extension already has access to. OFF by default and in every build: a
    // detected page is only ever offered the button until the user opts in here.
    autoFollowDetected: boolean
    readingMode: "continuous" | "single"
    // Default pages-per-view for the paged reader: 1 (single) or 2 (double spread). Combined with
    // readingMode this expresses the reader's 3-way default view (Strip = continuous+1, Single =
    // single+1, Double = single+2). Applied on the FIRST open of a title; a per-title choice made
    // in the reader afterwards is remembered and wins.
    readingSpread: 1 | 2
    readingDirection: ReadingDirection
    pageFit: PageFit
    showPageNumber: boolean
    noGapContinuous: boolean
    // Gap in px between the two pages of a Double-page spread (0-40). Seamless mode forces 0.
    spreadGapPx: number
    // How much of the viewport width the "Fit width" fit fills, as a percent (30-100). 100
    // fills edge to edge; lower it for comfortable long-strip reading. Upscales small pages.
    pageWidthPct: number
    preloadPages: number
    openChapterIn: OpenChapterIn
    theme: "dark" | "light" | "system"
    language: string
    dailyGoal: number
    blurNsfw: boolean
    updateIntervalHours: 0 | 6 | 12 | 24
    notifyNewChapters: boolean
    autoBackup: boolean
    // Auto-pause a title whose most recent read is older than this many days (0 = off).
    // Consumed by effectiveReadingStatus (reading-status.ts).
    autoPauseDays: number
    // When importing an AniList list, include entries the user has PAUSED / DROPPED
    // there (default true). When false, those entries are skipped on import.
    anilistImportPaused: boolean
    anilistImportDropped: boolean
    // Include PLANNING entries on import (default false - a first import stays focused on
    // what you actually read; enable to pull your plan-to-read list in too).
    anilistImportPlanning: boolean
    // Source ids the user toggled OFF for search on the Sources tab. Aggregate search
    // (manga:search + the streaming Home search) skips these so a big library isn't
    // querying every adapter every time. Empty = search all (default).
    searchDisabledSourceIds: string[]
    // Discover "mix it up": re-order suggestions to break up runs of the same genre so the
    // grid isn't dominated by whatever the biggest slice of the library is. On by default;
    // turn off for a pure highest-score-first ordering.
    discoverDiversify: boolean
    // Which page the app opens to. Discover (default) or the Library.
    startPage: "discover" | "library"
    // Show the weeb.ltd Community link (sidebar nav + footer). On by default; the links also
    // hide automatically whenever the site is unreachable, so a dead/retired site never leaves
    // a broken button behind.
    showCommunity: boolean
    // Anonymous usage analytics (which screens/features are used, capture success, app version).
    // On by default on a legitimate-interest basis (see ECO_ANALYTICS_LIA.md); never carries
    // titles, genres, URLs, or any content. Quiet opt-out - turning it off stops sending
    // immediately. Also suppressed when a linked account has opted out.
    usageAnalytics: boolean
    // Chrome-only gate: the Chrome Web Store requires affirmative consent BEFORE collection, so on
    // the Chrome build nothing is sent until the user makes a first-run choice (true once chosen).
    // Ignored on Firefox, where default-on + this opt-out is store-compliant.
    usageAnalyticsChoice: boolean
}

const settingsKey = "settings"

export const defaultSettings: AppSettings = {
    autoAdd: true,
    markReadOnVisit: true,
    autoFollowDetected: false,
    readingMode: "continuous",
    readingSpread: 1,
    readingDirection: "ltr",
    pageFit: "width",
    showPageNumber: true,
    noGapContinuous: false,
    spreadGapPx: 8,
    pageWidthPct: 100,
    preloadPages: 3,
    openChapterIn: "reader",
    theme: "dark",
    language: "en",
    dailyGoal: 0,
    blurNsfw: true,
    updateIntervalHours: 12,
    notifyNewChapters: true,
    autoBackup: true,
    autoPauseDays: 0,
    anilistImportPaused: true,
    anilistImportDropped: true,
    anilistImportPlanning: false,
    searchDisabledSourceIds: [],
    discoverDiversify: true,
    startPage: "discover",
    showCommunity: true,
    usageAnalytics: true,
    usageAnalyticsChoice: false
}

export async function getSettings(): Promise<AppSettings> {
    const stored = await browser.storage.local.get(settingsKey)
    return { ...defaultSettings, ...(stored[settingsKey] as Partial<AppSettings> | undefined) }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const settings = { ...(await getSettings()), ...patch }
    await browser.storage.local.set({ [settingsKey]: settings })
    return settings
}
