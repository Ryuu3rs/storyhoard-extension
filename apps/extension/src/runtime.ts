import { z } from "zod"
import { validateUsername } from "@amr/normalize"

export const runtimeRequestSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("library:list") }),
    z.object({ type: z.literal("library:get"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("library:remove"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("library:clear") }),
    z.object({ type: z.literal("library:clear-history") }),
    z.object({ type: z.literal("library:rate"), mangaId: z.string().min(1), rating: z.number().int().min(0).max(5) }),
    z.object({ type: z.literal("library:manual"), mangaId: z.string().min(1), manual: z.boolean() }),
    z.object({ type: z.literal("library:hold"), mangaId: z.string().min(1), onHold: z.boolean() }),
    z.object({
        type: z.literal("library:status"),
        mangaId: z.string().min(1),
        status: z.union([z.enum(["paused", "dropped", "planning"]), z.null()])
    }),
    z.object({ type: z.literal("library:nsfw"), mangaId: z.string().min(1), nsfw: z.boolean() }),
    z.object({
        type: z.literal("library:categories"),
        mangaId: z.string().min(1),
        categories: z.array(z.string().trim().min(1)).max(20)
    }),
    z.object({
        type: z.literal("library:numbers"),
        mangaId: z.string().min(1),
        latestChapterNumber: z.union([z.number().finite().nonnegative(), z.null()]).optional(),
        lastReadChapterNumber: z.union([z.number().finite().nonnegative(), z.null()]).optional(),
        lastReadChapterId: z.union([z.string(), z.null()]).optional()
    }),
    z.object({ type: z.literal("library:dismiss"), mangaId: z.string().min(1) }),
    z.object({
        type: z.literal("library:merge"),
        primaryId: z.string().min(1),
        loserIds: z.array(z.string().min(1)).min(1).max(50)
    }),
    z.object({ type: z.literal("library:cleanup:scan") }),
    z.object({
        type: z.literal("library:cleanup:apply"),
        groups: z
            .array(
                z.object({
                    canonicalId: z.string().min(1),
                    sourceId: z.string().min(1),
                    sourceMangaId: z.string().min(1),
                    mangaUrl: z.string(),
                    representativeChapterUrl: z.string(),
                    losers: z
                        .array(
                            z.object({
                                mangaId: z.string().min(1),
                                matchedBy: z.enum(["adapter", "pathname", "scrape"])
                            })
                        )
                        .max(200)
                })
            )
            .min(1)
            .max(100)
    }),
    z.object({ type: z.literal("library:relink"), mangaId: z.string().min(1), url: z.url() }),
    z.object({ type: z.literal("library:link-url"), mangaId: z.string().min(1), mangaUrl: z.url() }),
    z.object({
        type: z.literal("library:switch"),
        mangaId: z.string().min(1),
        sourceId: z.string().min(1),
        sourceMangaId: z.string().min(1),
        mangaUrl: z.url(),
        allowTabFallback: z.boolean().optional()
    }),
    z.object({
        type: z.literal("library:add"),
        sourceId: z.string().min(1),
        sourceMangaId: z.string().min(1),
        mangaUrl: z.url(),
        title: z.string().trim().min(1),
        coverUrl: z.url().optional()
    }),
    z.object({
        type: z.literal("library:quick-add"),
        anilistId: z.number().int().positive(),
        title: z.string().trim().min(1),
        coverUrl: z.string().optional(),
        genres: z.array(z.string()).optional(),
        mode: z.enum(["read", "planning"])
    }),
    z.object({ type: z.literal("library:covers:backfill"), mangaId: z.string().optional() }),
    z.object({ type: z.literal("library:metadata:backfill") }),
    z.object({ type: z.literal("stats:get") }),
    z.object({ type: z.literal("history:list") }),
    z.object({ type: z.literal("chapter:adjacent"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("chapter:resume"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("library:note"), mangaId: z.string().min(1), note: z.string() }),
    z.object({
        type: z.literal("library:reading-prefs"),
        mangaId: z.string().min(1),
        readingDirection: z.union([z.enum(["ltr", "rtl", "vertical"]), z.null()]).optional(),
        pageFit: z.union([z.enum(["width", "height", "contain", "original", "actual"]), z.null()]).optional(),
        pageWidthPct: z.union([z.number().int().min(30).max(100), z.null()]).optional(),
        noGapContinuous: z.union([z.boolean(), z.null()]).optional(),
        continuousScroll: z.union([z.boolean(), z.null()]).optional(),
        readerTheme: z.union([z.enum(["auto", "light", "dark"]), z.null()]).optional()
    }),
    z.object({ type: z.literal("activity:get"), days: z.number().int().positive().optional() }),
    z.object({ type: z.literal("data:export") }),
    z.object({ type: z.literal("data:import:preview"), envelope: z.unknown() }),
    z.object({
        type: z.literal("data:import"),
        envelope: z.unknown(),
        resolutions: z.record(z.string(), z.enum(["overwrite", "skip", "merge"])).optional()
    }),
    z.object({ type: z.literal("data:seed") }),
    z.object({ type: z.literal("data:backup:list") }),
    z.object({ type: z.literal("data:backup:restore"), id: z.number().int().nonnegative() }),
    z.object({ type: z.literal("sync:status") }),
    z.object({
        type: z.literal("sync:config"),
        config: z.object({
            token: z.string().optional(),
            gistId: z.string().optional(),
            autoSync: z.boolean().optional()
        })
    }),
    z.object({ type: z.literal("sync:push") }),
    z.object({ type: z.literal("sync:pull") }),
    z.object({ type: z.literal("anilist:status") }),
    z.object({
        type: z.literal("anilist:config"),
        config: z.object({
            token: z.string().optional(),
            autoSync: z.boolean().optional(),
            syncMembership: z.boolean().optional(),
            statusPush: z.boolean().optional(),
            statusPull: z.boolean().optional()
        })
    }),
    z.object({ type: z.literal("anilist:sync") }),
    z.object({ type: z.literal("anilist:import") }),
    z.object({ type: z.literal("log:export") }),
    z.object({ type: z.literal("manga:search"), query: z.string().min(1) }),
    z.object({ type: z.literal("manga:chapters"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("manga:genres"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("source:permission:check") }),
    z.object({ type: z.literal("sources:list") }),
    z.object({ type: z.literal("sources:ping") }),
    z.object({ type: z.literal("sources:health") }),
    z.object({ type: z.literal("updates:check"), sourceId: z.string().optional() }),
    z.object({ type: z.literal("updates:get") }),
    z.object({ type: z.literal("extension-update:check"), force: z.boolean().optional() }),
    z.object({ type: z.literal("extension-update:download") }),
    z.object({ type: z.literal("updates:new-chapters"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("page:current") }),
    z.object({ type: z.literal("page:capture"), url: z.url() }),
    z.object({ type: z.literal("reader:resolve"), url: z.url() }),
    z.object({ type: z.literal("chapter:siblings"), url: z.url() }),
    z.object({
        type: z.literal("analytics:record"),
        event: z.string(),
        sourceId: z.string().optional(),
        detail: z.string().optional()
    }),
    z.object({ type: z.literal("analytics:summary"), days: z.number().int().positive().optional() }),
    z.object({
        type: z.literal("reader:chapters"),
        sourceId: z.string().min(1),
        sourceMangaId: z.string().min(1),
        mangaUrl: z.url(),
        mangaId: z.string().min(1)
    }),
    z.object({ type: z.literal("reader:progress:get"), chapterId: z.string().min(1) }),
    z.object({
        type: z.literal("reader:progress"),
        mangaId: z.string().min(1),
        chapterId: z.string().min(1),
        pageIndex: z.number().int().nonnegative(),
        pageCount: z.number().int().positive(),
        completed: z.boolean()
    }),
    z.object({
        type: z.literal("bookmark:toggle"),
        mangaId: z.string().min(1),
        chapterId: z.string().min(1),
        pageIndex: z.number().int().nonnegative(),
        mangaTitle: z.string(),
        chapterTitle: z.string(),
        chapterUrl: z.url()
    }),
    z.object({ type: z.literal("bookmark:pages"), chapterId: z.string().min(1) }),
    z.object({ type: z.literal("bookmark:list") }),
    z.object({ type: z.literal("bookmark:remove"), id: z.string().min(1) }),
    z.object({ type: z.literal("chapter:download"), url: z.url() }),
    z.object({
        type: z.literal("chapter:track"),
        url: z.url(),
        // The chapter label the page itself shows (selected dropdown entry, current link, document
        // title). The handler reads the chapter number from it for a source whose URL holds no number.
        label: z.string().max(200).optional()
    }),
    // A reader page the user has not followed: the panel asks the background to keep a local, tracking-only
    // record of the visit (see detected-site.ts) so the page's own chapter list has a title to attach to.
    // `explicit` is true for a click on Mark read, which adds the title even when auto-add is off.
    z.object({
        type: z.literal("work:track-detected"),
        url: z.url(),
        label: z.string().max(200).optional(),
        explicit: z.boolean().optional()
    }),
    z.object({ type: z.literal("chapter:open-in-reader"), url: z.url() }),
    // ARCH TRACK A: best-version surfacing. open-best ranks a work's versions and opens the best
    // source's own page in a tab (the on-site destination that replaces the in-app reader).
    // best-for-url backs the on-site panel's quiet "a more complete version is available" hint.
    z.object({ type: z.literal("work:open-best"), mangaId: z.string().min(1) }),
    z.object({ type: z.literal("work:best-for-url"), url: z.url() }),
    // The on-site panel's chapter dropdown. Typed (not an arch-only raw message) because the panel
    // ships to every user, so the handler must too.
    z.object({ type: z.literal("work:chapter-list"), url: z.url() }),
    // The chapter list the on-site panel read from the user's own rendered page. Every item is
    // re-validated by the handler (own origin, own chapter URL shape, number parsed from the text).
    z.object({
        type: z.literal("work:record-chapter-list"),
        url: z.url(),
        mangaId: z.string().min(1).optional(),
        items: z.array(z.object({ url: z.string().max(2048), text: z.string().max(300) })).max(2000)
    }),
    // Record cross-source versions for a tracked title (from a mirror check), so the ranker and the
    // on-site "better version" hint have real alternatives to compare against the user's source.
    z.object({
        type: z.literal("work:record-mirrors"),
        mangaId: z.string().min(1),
        mirrors: z
            .array(
                z.object({
                    sourceId: z.string().min(1),
                    sourceMangaId: z.string().optional(),
                    url: z.url(),
                    latestChapter: z.string().optional()
                })
            )
            .max(200)
    }),
    z.object({ type: z.literal("chapter:download:get"), chapterId: z.string().min(1) }),
    z.object({ type: z.literal("chapter:download:remove"), chapterId: z.string().min(1) }),
    z.object({ type: z.literal("downloads:list") }),
    z.object({ type: z.literal("community:status") }),
    z.object({
        type: z.literal("community:register"),
        username: z.string().refine(v => validateUsername(v).ok, "invalid username")
    }),
    z.object({ type: z.literal("community:toggle"), enabled: z.boolean() }),
    z.object({ type: z.literal("community:decline") }),
    z.object({ type: z.literal("community:delete-data") }),
    z.object({ type: z.literal("community:sync") }),
    z.object({
        type: z.literal("community:rate"),
        mangaTitle: z.string().min(1),
        rating: z.number().int().min(1).max(5)
    }),
    z.object({ type: z.literal("community:manga-stats"), mangaTitle: z.string().min(1) }),
    z.object({ type: z.literal("community:announcements") }),
    z.object({ type: z.literal("community:trending") }),
    z.object({ type: z.literal("account:status") }),
    z.object({ type: z.literal("account:link"), token: z.string().trim().min(10).max(200) }),
    z.object({ type: z.literal("account:unlink") }),
    z.object({ type: z.literal("account:sync") }),
    z.object({ type: z.literal("account:wallet") }),
    z.object({ type: z.literal("source:info"), sourceId: z.string().min(1).max(64) }),
    // "Add site": detect a reader page the extension does not recognise, add it as a source from
    // the user's click, and manage the sources added that way. `url` must still be the tab's page.
    z.object({ type: z.literal("source:detect"), url: z.url(), tabId: z.number().int().nonnegative().optional() }),
    z.object({
        type: z.literal("source:add-from-tab"),
        url: z.url(),
        tabId: z.number().int().nonnegative().optional(),
        // True when the popup requested the site's host access itself for this add, so a failed add
        // revokes it.
        grantedByCaller: z.boolean().optional()
    }),
    z.object({ type: z.literal("source:list") }),
    z.object({ type: z.literal("source:tracking-only") }),
    z.object({ type: z.literal("source:remove"), id: z.string().min(1).max(100) }),
    z.object({
        type: z.literal("source:resolve"),
        anilistId: z.number().int().positive().optional(),
        title: z.string().trim().min(1),
        searchTitles: z.array(z.string().trim().min(1)).max(10).optional()
    }),
    z.object({ type: z.literal("suggestions:get"), force: z.boolean().optional() }),
    z.object({ type: z.literal("suggestions:continue") }),
    z.object({ type: z.literal("suggestions:hide"), anilistId: z.number().int().positive() }),
    z.object({ type: z.literal("suggestions:unhide"), anilistId: z.number().int().positive() }),
    z.object({ type: z.literal("settings:get") }),
    z.object({
        type: z.literal("settings:update"),
        settings: z.object({
            autoAdd: z.boolean().optional(),
            markReadOnVisit: z.boolean().optional(),
            readingMode: z.enum(["continuous", "single"]).optional(),
            readingSpread: z.union([z.literal(1), z.literal(2)]).optional(),
            readingDirection: z.enum(["ltr", "rtl", "vertical"]).optional(),
            pageFit: z.enum(["width", "height", "contain", "original", "actual"]).optional(),
            showPageNumber: z.boolean().optional(),
            noGapContinuous: z.boolean().optional(),
            spreadGapPx: z.number().int().min(0).max(40).optional(),
            pageWidthPct: z.number().int().min(30).max(100).optional(),
            preloadPages: z.number().int().min(0).max(10).optional(),
            openChapterIn: z.enum(["reader", "browser"]).optional(),
            theme: z.enum(["dark", "light", "system"]).optional(),
            language: z.string().min(2).max(8).optional(),
            dailyGoal: z.number().int().min(0).max(50).optional(),
            blurNsfw: z.boolean().optional(),
            updateIntervalHours: z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(24)]).optional(),
            notifyNewChapters: z.boolean().optional(),
            autoBackup: z.boolean().optional(),
            searchDisabledSourceIds: z.array(z.string()).optional(),
            autoPauseDays: z.number().int().min(0).max(3650).optional(),
            anilistImportPaused: z.boolean().optional(),
            anilistImportDropped: z.boolean().optional(),
            anilistImportPlanning: z.boolean().optional(),
            discoverDiversify: z.boolean().optional(),
            startPage: z.enum(["discover", "library"]).optional(),
            showCommunity: z.boolean().optional(),
            usageAnalytics: z.boolean().optional(),
            usageAnalyticsChoice: z.boolean().optional()
        })
    }),
    z.object({
        type: z.literal("import:reader"),
        format: z.string().min(1),
        dataB64: z.string().min(1),
        preview: z.boolean().optional()
    }),
    z.object({
        type: z.literal("import:resolve")
    }),
    z.object({
        type: z.literal("site:open"),
        anilistId: z.number().int().positive(),
        title: z.string(),
        coverUrl: z.string().url().optional(),
        genres: z.array(z.string()).optional()
    })
])

export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>

export type RuntimeResponse<T = unknown> =
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }

export async function sendRuntimeMessage<T>(request: RuntimeRequest): Promise<T> {
    const response = (await browser.runtime.sendMessage(request)) as RuntimeResponse<T>

    if (!response.ok) {
        throw new Error(response.error.message)
    }

    return response.data
}
