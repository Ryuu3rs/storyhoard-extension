<script lang="ts">
    import type { ReadingProgress } from "@amr/contracts"
    import type { ResolvedChapter } from "@amr/source-sdk"
    import { onDestroy, onMount } from "svelte"
    import { sendRuntimeMessage } from "../../src/runtime"
    import { AMR_KOFI_URL, AMR_SUPPORT_LABEL, supportPlatform } from "../../src/support"
    import { subscribeLive } from "../../src/live"
    import { createProgressReporter } from "../../src/throttle"
    import { spreadView } from "../../src/reader-spread"

    type ReadingDirection = "ltr" | "rtl" | "vertical"
    type PageFit = "width" | "height" | "contain" | "original" | "actual"

    let chapter = $state<ResolvedChapter | undefined>()
    let error = $state("")
    let resolving = $state(false)
    let currentPage = $state(0)
    let mode = $state<"continuous" | "single">("continuous")
    // Pages shown at once in paged mode: 1 (single) or 2 (side-by-side spread).
    let spread = $state<1 | 2>(1)
    // 2-up "offset": show page 0 (cover) alone, then pair [1,2],[3,4],... per title.
    let spreadOffset = $state(false)
    // 2-up "seamless": drop the centre gutter so a connected spread's two halves join.
    let spreadSeamless = $state(false)
    let direction = $state<ReadingDirection>("ltr")
    let pageFit = $state<PageFit>("width")
    let showPageNumber = $state(true)
    let noGapContinuous = $state(false)
    // Gap in px between the two pages of a Double-page spread (from settings; seamless forces 0).
    let spreadGapPx = $state(8)
    // Percent of the viewport width the Fit-width fit fills (30-100; from settings).
    let pageWidthPct = $state(100)
    // Per-series page-width override: null = inherit the global default, else an explicit
    // per-title percent saved via library:reading-prefs. When set, a change to the global
    // page-width setting must not clobber it.
    let pageWidthOverride = $state<number | null>(null)
    // Per-series "Webtoon view" override: null = no override (inherits the global
    // default), true/false = explicit per-series value saved via library:reading-prefs.
    let noGapOverride = $state<boolean | null>(null)
    let noGapDefault = $state(false)
    let noGapSaved = $state(false)
    let noGapSavedTimer: ReturnType<typeof setTimeout> | undefined
    let preloadPages = $state(3)
    let chapterUrl = $state("")
    let siblings = $state<Array<{ url: string; sortKey: number; title: string }>>([])
    let fitOverride = $state<PageFit | null>(null)
    let isFullscreen = $state(false)
    let chromeHidden = $state(false)
    let mangaId = $state("")
    let showHelp = $state(false)
    type SourceInfo = { id: string; name: string; homepage: string | null; supportUrl: string | null }
    let sourceInfo = $state<SourceInfo | null>(null)
    $effect(() => {
        const sourceId = chapter?.manga.sourceId
        if (!sourceId) {
            sourceInfo = null
            return
        }
        void sendRuntimeMessage<SourceInfo | null>({ type: "source:info", sourceId })
            .then(info => {
                if (chapter?.manga.sourceId === sourceId) sourceInfo = info
            })
            .catch(() => {
                sourceInfo = null
            })
    })

    // Fallback: when a chapter fails to resolve or its page images won't load,
    // let the user search every source for a working mirror.
    type SearchResult = {
        sourceId: string
        sourceMangaId: string
        title: string
        url: string
        coverUrl?: string
        latestChapter?: string
    }
    let failedPages = $state(new Set<number>())
    let mirrorOpen = $state(false)
    let mirrorLoading = $state(false)
    let mirrorSearched = $state(false)
    let mirrorResults = $state<SearchResult[]>([])
    let trackMessage = $state("")

    let bookmarkedPages = $state(new Set<number>())
    const isBookmarked = $derived(bookmarkedPages.has(currentPage))
    let bookmarkWorking = $state(false)

    $effect(() => {
        if (!chapter) {
            bookmarkedPages = new Set()
            return
        }
        const chapterId = chapter.chapter.id
        void sendRuntimeMessage<number[]>({ type: "bookmark:pages", chapterId })
            .then(pages => {
                // Ignore stale responses if the chapter changed before this resolved.
                if (chapter?.chapter.id === chapterId) bookmarkedPages = new Set(pages)
            })
            .catch(() => {})
    })

    async function togglePageBookmark() {
        if (!chapter || bookmarkWorking) return
        bookmarkWorking = true
        // Capture the exact chapter + page this toggle is FOR, before the await. Page nav isn't
        // gated by bookmarkWorking, so currentPage (and even the chapter) can change mid-request;
        // re-reading them afterwards would star the wrong page (or the wrong chapter).
        const chapterId = chapter.chapter.id
        const pageIndex = currentPage
        try {
            const added = await sendRuntimeMessage<boolean>({
                type: "bookmark:toggle",
                mangaId: chapter.manga.manga.id,
                chapterId,
                pageIndex,
                mangaTitle: chapter.manga.manga.title,
                chapterTitle: chapter.chapter.title,
                chapterUrl: chapter.chapter.url
            })
            // Only apply the optimistic UI update if we're still on the same chapter, and always
            // to the captured page - never the live currentPage. Reassign (not mutate) so Svelte
            // 5's $state proxy recomputes isBookmarked.
            if (chapter?.chapter.id === chapterId) {
                const next = new Set(bookmarkedPages)
                if (added) next.add(pageIndex)
                else next.delete(pageIndex)
                bookmarkedPages = next
            }
        } catch {
            // ignore
        } finally {
            bookmarkWorking = false
        }
    }

    let showCatPanel = $state(false)
    let mangaCategories = $state<string[]>([])
    let catInput = $state("")
    let catSaving = $state(false)

    $effect(() => {
        const id = mangaId
        if (!id) {
            mangaCategories = []
            return
        }
        void sendRuntimeMessage<{ categories?: string[] } | null>({ type: "library:get", mangaId: id })
            .then(m => {
                // Stale-response guard (mirrors the bookmark effect above): a slow library:get
                // for the previous title must not overwrite the tags after a fast chapter switch,
                // or the Tag panel shows - and saves to - the wrong title.
                if (id === mangaId) mangaCategories = m?.categories ?? []
            })
            .catch(() => {})
    })

    async function saveCategories(next: string[]) {
        if (!mangaId || catSaving) return
        catSaving = true
        try {
            await sendRuntimeMessage({ type: "library:categories", mangaId, categories: next })
            mangaCategories = next
        } catch {
            // ignore
        } finally {
            catSaving = false
        }
    }

    function addCategory() {
        const tag = catInput.trim()
        catInput = ""
        if (!tag || mangaCategories.includes(tag)) return
        void saveCategories([...mangaCategories, tag])
    }

    function removeCategory(tag: string) {
        void saveCategories(mangaCategories.filter(c => c !== tag))
    }

    // Open the chapter on its own site and still record it as read - the no-scrape
    // Only open a source-controlled URL in a tab if it is http(s): an adapter-parsed
    // chapter/source URL must never hand a javascript:/data:/file: scheme to tabs.create.
    function openExternal(url: string | undefined | null): boolean {
        if (!url) return false
        try {
            const protocol = new URL(url).protocol
            if (protocol !== "http:" && protocol !== "https:") return false
        } catch {
            return false
        }
        void browser.tabs.create({ url })
        return true
    }

    // fallback for sources whose images the in-app reader can't load.
    async function openOnSiteAndTrack() {
        if (!chapterUrl) return
        openExternal(chapterUrl)
        try {
            const res = await sendRuntimeMessage<{
                supported: boolean
                tracked?: boolean
                title?: string
                chapterNumber?: number | null
            }>({ type: "chapter:track", url: chapterUrl })
            trackMessage =
                res.supported && res.tracked
                    ? `Marked ${res.title}${res.chapterNumber != null ? ` ch ${res.chapterNumber}` : ""} as read.`
                    : "Opened on the source site."
        } catch {
            trackMessage = "Opened on the source site."
        }
    }

    function slugFromUrl(url: string): string {
        try {
            const segments = new URL(url).pathname.split("/").filter(Boolean)
            const candidate = segments.find(s => /[a-z]/i.test(s) && s !== "manga" && s !== "chapter")
            if (!candidate) return ""
            return decodeURIComponent(candidate).replace(/[-_]+/g, " ").trim()
        } catch {
            return ""
        }
    }

    const mirrorQuery = $derived(chapter?.manga.manga.title ?? slugFromUrl(chapterUrl))
    const sourceUrl = $derived(chapter?.manga.url ?? "")
    const sourceDomain = $derived(sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : "")

    // pages.length === 0 means the adapter returned sidebar-only metadata (no reader).
    const zeroPages = $derived(Boolean(chapter) && chapter!.pages.length === 0)
    const imagesBroken = $derived.by(() => {
        if (!chapter || chapter.pages.length === 0) return false
        const pageCount = chapter.pages.length
        if (effectiveMode === "single") {
            // Paged mode mounts only the current one or two pages, so trip when every page in
            // the current view has failed. A page only enters failedPages after handleImageError
            // exhausts its retries (i.e. it's confirmed dead, not a transient blip), so a single
            // dead page the user is stuck on must surface the fallback - no second-failure gate.
            return spreadIndices.length > 0 && spreadIndices.every(p => failedPages.has(p))
        }
        return failedPages.size >= pageCount
    })

    async function findOnAnotherMirror() {
        mirrorOpen = true
        if (!mirrorQuery) {
            mirrorResults = []
            mirrorSearched = true
            return
        }
        mirrorLoading = true
        mirrorSearched = false
        try {
            const results = await sendRuntimeMessage<SearchResult[]>({ type: "manga:search", query: mirrorQuery })
            const currentSourceId = chapter?.manga.sourceId
            mirrorResults = currentSourceId ? results.filter(r => r.sourceId !== currentSourceId) : results
        } catch {
            mirrorResults = []
        } finally {
            mirrorLoading = false
            mirrorSearched = true
        }
    }

    const mirrorResultsBySource = $derived.by(() => {
        const groups = new Map<string, SearchResult[]>()
        for (const result of mirrorResults) {
            const existing = groups.get(result.sourceId)
            if (existing) existing.push(result)
            else groups.set(result.sourceId, [result])
        }
        return [...groups.entries()]
    })

    function openMirror(result: SearchResult) {
        openExternal(result.url)
    }

    // A9: offline downloads. When a chapter has been downloaded, render the
    // stored Blobs via object URLs instead of the remote page URLs.
    let offlinePages = $state<string[]>([])
    let downloaded = $state(false)
    let downloading = $state(false)
    let removingDownload = $state(false)

    function revokeOfflinePages() {
        for (const url of offlinePages) URL.revokeObjectURL(url)
        offlinePages = []
    }

    // The page srcs the reader renders: offline blobs when available, else remote.
    const pageSrcs = $derived.by(() => {
        if (!chapter) return [] as string[]
        if (offlinePages.length === chapter.pages.length && offlinePages.length > 0) return offlinePages
        return chapter.pages.map(p => p.url)
    })

    async function refreshDownloadState(chapterId: string) {
        try {
            const record = await sendRuntimeMessage<{ pageBlobs: Blob[]; pageCount: number } | null>({
                type: "chapter:download:get",
                chapterId
            })
            // Bail if the chapter switched while the lookup was in flight - otherwise
            // we'd paint chapter A's offline blobs over chapter B and leak A's URLs.
            if (chapter?.chapter.id !== chapterId) return
            revokeOfflinePages()
            if (record && record.pageBlobs.length > 0) {
                downloaded = true
                offlinePages = record.pageBlobs.map(blob => URL.createObjectURL(blob))
            } else {
                downloaded = false
            }
        } catch {
            // offline read is best-effort
        }
    }

    async function downloadChapter() {
        if (!chapter || downloading) return
        // Capture the target chapter up front: reading chapter.chapter.id AFTER the (long,
        // up-to-200-page) download would refresh whatever chapter the user navigated to
        // meanwhile, not the one that was actually downloaded.
        const url = chapter.chapter.url
        const id = chapter.chapter.id
        downloading = true
        try {
            await sendRuntimeMessage({ type: "chapter:download", url })
            await refreshDownloadState(id)
        } catch (cause) {
            error = cause instanceof Error ? cause.message : "The chapter could not be downloaded"
        } finally {
            downloading = false
        }
    }

    async function removeChapterDownload() {
        if (!chapter || removingDownload) return
        removingDownload = true
        // Capture the chapter this remove is FOR: if the user navigates while the backend
        // removal is in flight, revoking offlinePages + clearing `downloaded` unconditionally
        // would blow away the NEW chapter's offline URLs and mis-flag it as not-downloaded.
        const chapterId = chapter.chapter.id
        try {
            await sendRuntimeMessage({ type: "chapter:download:remove", chapterId })
            if (chapter?.chapter.id === chapterId) {
                revokeOfflinePages()
                downloaded = false
            }
        } catch {
            // ignore
        } finally {
            removingDownload = false
        }
    }

    // A11: export a downloaded chapter as a real CBZ file on disk. A CBZ is just a
    // ZIP of images, so we hand-roll a minimal STORED-mode (uncompressed) ZIP writer
    // rather than pull in a dependency - images are already compressed, so STORED
    // mode costs nothing and keeps this self-contained for the MV3 page context.
    let exportingCbz = $state(false)
    let exportCbzError = $state("")

    function sanitizeFilenamePart(name: string): string {
        return (
            name
                .replace(/[\\/:*?"<>|]/g, "_")
                .replace(/\s+/g, " ")
                // Strip C0/C1 control chars (NUL and friends) that \s didn't cover, so
                // they can't reach browser.downloads.download({filename}). Runs after the
                // \s collapse so tab/newline still become a single visible space.
                .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
                .trim() || "untitled"
        )
    }

    function extFromMime(mime: string): string {
        switch (mime) {
            case "image/png":
                return ".png"
            case "image/webp":
                return ".webp"
            case "image/gif":
                return ".gif"
            case "image/avif":
                return ".avif"
            default:
                return ".jpg"
        }
    }

    let crcTable: Uint32Array | undefined
    function crc32(data: Uint8Array<ArrayBuffer>): number {
        if (!crcTable) {
            const table = new Uint32Array(256)
            for (let n = 0; n < 256; n += 1) {
                let c = n
                for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
                table[n] = c >>> 0
            }
            crcTable = table
        }
        let crc = 0xffffffff
        for (let i = 0; i < data.length; i += 1) {
            crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
        }
        return (crc ^ 0xffffffff) >>> 0
    }

    function dosDateTime(date: Date): { time: number; date: number } {
        const time =
            ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f)
        const dosDate =
            (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f)
        return { time, date: dosDate }
    }

    // Builds a valid ZIP (local file headers + central directory + EOCD record) using
    // compression method 0 (STORED) so no deflate implementation is needed.
    function buildZip(entries: { name: string; data: Uint8Array<ArrayBuffer> }[]): Blob {
        const encoder = new TextEncoder()
        const { time, date } = dosDateTime(new Date())
        const localParts: Uint8Array<ArrayBuffer>[] = []
        const centralParts: Uint8Array<ArrayBuffer>[] = []
        let offset = 0

        for (const entry of entries) {
            const nameBytes = encoder.encode(entry.name)
            const crc = crc32(entry.data)
            const size = entry.data.length

            const localHeader = new Uint8Array(30 + nameBytes.length)
            const lv = new DataView(localHeader.buffer)
            lv.setUint32(0, 0x04034b50, true)
            lv.setUint16(4, 20, true)
            lv.setUint16(6, 0, true)
            lv.setUint16(8, 0, true)
            lv.setUint16(10, time, true)
            lv.setUint16(12, date, true)
            lv.setUint32(14, crc, true)
            lv.setUint32(18, size, true)
            lv.setUint32(22, size, true)
            lv.setUint16(26, nameBytes.length, true)
            lv.setUint16(28, 0, true)
            localHeader.set(nameBytes, 30)
            localParts.push(localHeader, entry.data)

            const centralHeader = new Uint8Array(46 + nameBytes.length)
            const cv = new DataView(centralHeader.buffer)
            cv.setUint32(0, 0x02014b50, true)
            cv.setUint16(4, 20, true)
            cv.setUint16(6, 20, true)
            cv.setUint16(8, 0, true)
            cv.setUint16(10, 0, true)
            cv.setUint16(12, time, true)
            cv.setUint16(14, date, true)
            cv.setUint32(16, crc, true)
            cv.setUint32(20, size, true)
            cv.setUint32(24, size, true)
            cv.setUint16(28, nameBytes.length, true)
            cv.setUint16(30, 0, true)
            cv.setUint16(32, 0, true)
            cv.setUint16(34, 0, true)
            cv.setUint16(36, 0, true)
            cv.setUint32(38, 0, true)
            cv.setUint32(42, offset, true)
            centralHeader.set(nameBytes, 46)
            centralParts.push(centralHeader)

            offset += localHeader.length + entry.data.length
        }

        const centralDirSize = centralParts.reduce((sum, p) => sum + p.length, 0)
        const centralDirOffset = offset

        const eocd = new Uint8Array(22)
        const ev = new DataView(eocd.buffer)
        ev.setUint32(0, 0x06054b50, true)
        ev.setUint16(4, 0, true)
        ev.setUint16(6, 0, true)
        ev.setUint16(8, entries.length, true)
        ev.setUint16(10, entries.length, true)
        ev.setUint32(12, centralDirSize, true)
        ev.setUint32(16, centralDirOffset, true)
        ev.setUint16(20, 0, true)

        return new Blob([...localParts, ...centralParts, eocd], { type: "application/vnd.comicbook+zip" })
    }

    async function exportCbz() {
        if (!chapter || exportingCbz) return
        exportingCbz = true
        exportCbzError = ""
        // Capture the chapter identity + names BEFORE the await-heavy blob loop: the user can
        // navigate (loadChapter reassigns `chapter`) while up to 200 blobs are decoded, and
        // reading the title afterwards would name the file for the NEW chapter while the bytes
        // are the old one's - a mislabeled CBZ written to disk. Mirrors downloadChapter's capture.
        const chapterId = chapter.chapter.id
        const mangaTitle = sanitizeFilenamePart(chapter.manga.manga.title)
        const chapterTitle = sanitizeFilenamePart(chapter.chapter.title)
        let objectUrl = ""
        try {
            const record = await sendRuntimeMessage<{ pageBlobs: Blob[]; pageCount: number } | null>({
                type: "chapter:download:get",
                chapterId
            })
            if (!record || record.pageBlobs.length === 0) {
                exportCbzError = "No offline pages to export"
                return
            }
            const digits = String(record.pageBlobs.length).length
            const entries: { name: string; data: Uint8Array<ArrayBuffer> }[] = []
            for (let i = 0; i < record.pageBlobs.length; i += 1) {
                const blob = record.pageBlobs[i]!
                const data = new Uint8Array(await blob.arrayBuffer())
                const name = `page_${String(i + 1).padStart(digits, "0")}${extFromMime(blob.type)}`
                entries.push({ name, data })
            }
            const zipBlob = buildZip(entries)
            objectUrl = URL.createObjectURL(zipBlob)
            await browser.downloads.download({
                url: objectUrl,
                filename: `${mangaTitle} - ${chapterTitle}.cbz`,
                saveAs: false
            })
        } catch (cause) {
            exportCbzError = cause instanceof Error ? cause.message : "CBZ export failed"
        } finally {
            exportingCbz = false
            // The download API reads the blob asynchronously; give it a head start
            // before releasing the object URL.
            if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
        }
    }

    // A10: remember the reading mode (scroll/single) and direction per title.
    async function setMode(next: "continuous" | "single") {
        mode = next
        if (mangaId) await browser.storage.local.set({ [`readerMode:${mangaId}`]: next })
    }

    async function setDirection(next: ReadingDirection) {
        direction = next
        if (mangaId) await browser.storage.local.set({ [`readerDirection:${mangaId}`]: next })
    }

    function cycleDirection() {
        const dirs: ReadingDirection[] = ["ltr", "rtl", "vertical"]
        const next = dirs[(dirs.indexOf(direction) + 1) % dirs.length]!
        void setDirection(next)
    }

    async function setSpread(next: 1 | 2) {
        spread = next
        if (mangaId) await browser.storage.local.set({ [`readerSpread:${mangaId}`]: next })
    }

    async function setSpreadOffset(next: boolean) {
        spreadOffset = next
        if (mangaId) await browser.storage.local.set({ [`readerSpreadOffset:${mangaId}`]: next })
    }

    async function setSpreadSeamless(next: boolean) {
        spreadSeamless = next
        if (mangaId) await browser.storage.local.set({ [`readerSeamless:${mangaId}`]: next })
    }

    // Per-series "Webtoon view" (no-gap continuous) override - mirrors setDirection's
    // shape, but persists to the library record via library:reading-prefs instead of
    // local storage, since this is a per-manga DB override rather than a device-local one.
    function flashNoGapSaved() {
        noGapSaved = true
        if (noGapSavedTimer) clearTimeout(noGapSavedTimer)
        noGapSavedTimer = setTimeout(() => {
            noGapSaved = false
        }, 1500)
    }

    async function setSeriesNoGap(value: boolean) {
        if (!mangaId) return
        // Optimistic - flip the visual state immediately, don't wait on the round trip.
        noGapOverride = value
        noGapContinuous = value
        try {
            await sendRuntimeMessage({ type: "library:reading-prefs", mangaId, noGapContinuous: value })
            flashNoGapSaved()
        } catch {
            // best-effort; local state already reflects the intended value
        }
    }

    function toggleSeriesNoGap() {
        void setSeriesNoGap(!(noGapOverride ?? noGapContinuous))
    }

    async function resetSeriesNoGap() {
        if (!mangaId) return
        noGapOverride = null
        noGapContinuous = noGapDefault
        try {
            await sendRuntimeMessage({ type: "library:reading-prefs", mangaId, noGapContinuous: null })
            flashNoGapSaved()
        } catch {
            // best-effort; local state already reflects the intended value
        }
    }

    // A two-page spread applies whenever the user picked it, except in vertical (webtoon)
    // direction which always scrolls as a single strip.
    const effectiveSpread = $derived(direction !== "vertical" && spread === 2 ? 2 : 1)
    // Vertical always scrolls continuously. A two-page spread is a PAGED flip view (Double:
    // turn two pages at a time with the arrow keys / wheel), so force paged mode whenever
    // spread is 2 - this also migrates 0.19's scroll-based double onto the flip view.
    const effectiveMode = $derived(direction === "vertical" ? "continuous" : effectiveSpread === 2 ? "single" : mode)
    const effectiveOffset = $derived(effectiveSpread === 2 && spreadOffset)
    const effectiveSeamless = $derived(effectiveSpread === 2 && spreadSeamless)
    // The single labelled 3-way view control: Strip (continuous 1-up scroll), Single (paged
    // 1-up flip), Double (paged 2-up flip). Direction (LTR/RTL) sets which way pages turn.
    type ViewMode = "strip" | "single" | "double"
    const viewMode = $derived<ViewMode>(
        effectiveSpread === 2 ? "double" : effectiveMode === "single" ? "single" : "strip"
    )

    function setView(v: ViewMode) {
        if (v === "strip") void Promise.all([setMode("continuous"), setSpread(1)])
        else if (v === "single") void Promise.all([setMode("single"), setSpread(1)])
        // Double is a paged 2-up flip view (not a scroll), so it uses the single/paged mode.
        else void Promise.all([setMode("single"), setSpread(2)])
    }

    // The page indices shown in the current paged view: one for Single, two for Double.
    // RTL page order within a spread is handled in CSS (row-reverse on main.dir-rtl).
    const spreadIndices = $derived(
        spreadView(currentPage, effectiveSpread, effectiveOffset, chapter?.pages.length ?? 0).indices
    )
    // A5: double-click toggles between the configured fit and original (zoom).
    const effectivePageFit = $derived(fitOverride ?? pageFit)
    const progressPct = $derived(
        chapter && chapter.pages.length > 0 ? Math.round(((currentPage + 1) / chapter.pages.length) * 100) : 0
    )

    // On-screen page nav for the single paged view: grey out at the ends (nextStart/prevStart
    // collapse onto the current start there, mirroring the keyboard handler's guards).
    const pageNavState = $derived.by(() => {
        if (!chapter) return { atStart: true, atEnd: true }
        const view = spreadView(currentPage, effectiveSpread, effectiveOffset, chapter.pages.length)
        const start = view.indices[0]!
        return { atStart: view.prevStart === start, atEnd: view.nextStart === start }
    })

    // hideChrome defaults true (keyboard / wheel turns tuck the overlay away). The on-screen
    // arrow buttons pass false: they live IN the overlay bar, so hiding it on every turn made
    // the button vanish mid-sequence and rapid clicks landed on whatever was underneath (pages
    // appearing to "jump around"). Keeping the bar under the cursor lets fast clicking work.
    function pageNav(dir: "prev" | "next", hideChrome = true) {
        if (!chapter) return
        const view = spreadView(currentPage, effectiveSpread, effectiveOffset, chapter.pages.length)
        const start = view.indices[0]!
        const target = dir === "next" ? view.nextStart : view.prevStart
        if (target !== start) {
            recordProgress(target)
            // Start each freshly-flipped page at the top so a tall (Actual size) page is read
            // from its beginning rather than wherever the previous page was scrolled to.
            if (effectiveMode === "single") {
                window.scrollTo({ top: 0 })
                if (hideChrome) chromeHidden = true
            }
        }
    }

    function toggleZoom() {
        // Zoom to true native resolution (Actual size), not the height-capped Original.
        fitOverride = fitOverride ? null : "actual"
    }

    // A6: fullscreen + immersive (auto-hide chrome on scroll-down).
    async function toggleFullscreen() {
        try {
            if (document.fullscreenElement) await document.exitFullscreen()
            else await document.documentElement.requestFullscreen()
        } catch {
            // ignore (denied / unsupported)
        }
    }

    // Wheel-to-flip for the paged views (Single + Double). Only acts when the page fits the
    // viewport - if the current page/spread is taller than the window (zoomed / original
    // fit), the native scroll wins so the user can still pan a big page. Throttled so one
    // wheel gesture turns exactly one page/spread. Direction is handled by pageNav via
    // spreadView (down = next in reading order, up = previous), so RTL just works.
    let lastWheel = 0
    function onWheel(event: WheelEvent) {
        if (effectiveMode !== "single" || !chapter) return
        if (Math.abs(event.deltaY) < 10) return
        // A page taller than the window scrolls first (Actual size / big pages); only flip
        // once the user is at the top/bottom edge, so "scroll then flip" reads naturally.
        const doc = document.documentElement
        if (doc.scrollHeight > window.innerHeight + 4) {
            const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 2
            const atTop = window.scrollY <= 0
            if (event.deltaY > 0 && !atBottom) return
            if (event.deltaY < 0 && !atTop) return
        }
        const now = Date.now()
        if (now - lastWheel < 250) return
        lastWheel = now
        pageNav(event.deltaY > 0 ? "next" : "prev")
    }

    let lastScroll = 0
    let scrollCompleteFired = false
    function onScroll() {
        const y = window.scrollY
        chromeHidden = y > 120 && y > lastScroll
        lastScroll = y
        if (!scrollCompleteFired && effectiveMode === "continuous" && chapter) {
            const nearBottom = y + window.innerHeight >= document.documentElement.scrollHeight - 50
            if (nearBottom) {
                scrollCompleteFired = true
                if (chapter.pages.length > 0) recordProgress(chapter.pages.length - 1)
            }
        }
    }

    // Strip hash fragments and re-sort query params so tracking-param/ordering
    // differences between the opened chapter URL and a mined sibling URL don't
    // break the match.
    function normalizeUrl(u: string): string {
        try {
            const parsed = new URL(u)
            parsed.hash = ""
            const sortedParams = new URLSearchParams(
                [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
            )
            parsed.search = sortedParams.toString()
            return parsed.toString()
        } catch {
            return u
        }
    }

    const currentIndex = $derived.by(() => {
        if (!chapter) return -1
        const url = chapter.chapter.url
        const exact = siblings.findIndex(s => s.url === url)
        if (exact >= 0) return exact
        const sortKey = chapter.chapter.sortKey
        const bySortKey = siblings.findIndex(s => s.sortKey === sortKey)
        if (bySortKey >= 0) return bySortKey
        const normalized = normalizeUrl(url)
        return siblings.findIndex(s => normalizeUrl(s.url) === normalized)
    })
    const prevUrl = $derived(currentIndex > 0 ? siblings[currentIndex - 1]?.url : undefined)
    const nextUrl = $derived(
        currentIndex >= 0 && currentIndex < siblings.length - 1 ? siblings[currentIndex + 1]?.url : undefined
    )

    async function loadSiblings(resolved: ResolvedChapter) {
        try {
            siblings = await sendRuntimeMessage<typeof siblings>({
                type: "reader:chapters",
                sourceId: resolved.manga.sourceId,
                sourceMangaId: resolved.manga.sourceMangaId,
                mangaUrl: resolved.manga.url,
                mangaId: resolved.manga.manga.id
            })
        } catch {
            siblings = []
        }
    }

    async function loadChapter(url: string) {
        // Flush any pending progress report for the chapter we're leaving before
        // its reporter (bound to the old mangaId/chapterId) is replaced below.
        progressReporter?.flush()
        resolving = true
        error = ""
        chapter = undefined
        revokeOfflinePages()
        downloaded = false
        failedPages = new Set()
        scrollCompleteFired = false
        mirrorOpen = false
        mirrorSearched = false
        mirrorResults = []
        // Don't carry a previous chapter's CBZ-export error onto the new chapter's button.
        exportCbzError = ""
        try {
            chapter = await sendRuntimeMessage<ResolvedChapter>({ type: "reader:resolve", url })
            progressReporter = createReporterForChapter(chapter)
            void loadSiblings(chapter)
            void refreshDownloadState(chapter.chapter.id)
            const progress = await sendRuntimeMessage<ReadingProgress | null>({
                type: "reader:progress:get",
                chapterId: chapter.chapter.id
            })
            // Clamp to this resolution's page count: a source that dropped pages since the last
            // read would otherwise leave currentPage past the end (>100% bar, "62/40" header,
            // bookmarks on a nonexistent page, frozen continuous progress).
            currentPage = Math.min(Math.max(0, progress?.pageIndex ?? 0), Math.max(0, chapter.pages.length - 1))
            // A10: load global settings + per-title overrides in parallel so mode is
            // set exactly once - no flicker from a global-default interim state.
            mangaId = chapter.manga.manga.id
            try {
                const modeKey = `readerMode:${mangaId}`
                const dirKey = `readerDirection:${mangaId}`
                const spreadKey = `readerSpread:${mangaId}`
                const spreadOffsetKey = `readerSpreadOffset:${mangaId}`
                const spreadSeamlessKey = `readerSeamless:${mangaId}`
                const [settings, stored, libraryManga] = await Promise.all([
                    sendRuntimeMessage<{
                        readingMode: "continuous" | "single"
                        readingSpread: 1 | 2
                        readingDirection: ReadingDirection
                        pageFit: PageFit
                        showPageNumber: boolean
                        noGapContinuous: boolean
                        spreadGapPx: number
                        pageWidthPct: number
                        preloadPages: number
                    }>({ type: "settings:get" }),
                    browser.storage.local
                        .get([modeKey, dirKey, spreadKey, spreadOffsetKey, spreadSeamlessKey])
                        .catch(() => ({}) as Record<string, unknown>),
                    sendRuntimeMessage<{
                        readingDirection?: ReadingDirection
                        pageFit?: PageFit
                        pageWidthPct?: number
                        noGapContinuous?: boolean
                    } | null>({ type: "library:get", mangaId }).catch(() => null)
                ])
                const modeOverride = stored[modeKey]
                const dirOverride = stored[dirKey]
                mode = modeOverride === "single" || modeOverride === "continuous" ? modeOverride : settings.readingMode
                // Per-title spread wins. With none stored, only a genuinely new title (no per-title
                // mode stored either) inherits the global "Default view" default; a title configured
                // before spread was tracked keeps the old single-page default rather than being
                // flipped to Double by a later global change.
                spread =
                    stored[spreadKey] === 2
                        ? 2
                        : stored[spreadKey] === 1
                          ? 1
                          : modeOverride !== undefined
                            ? 1
                            : settings.readingSpread === 2
                              ? 2
                              : 1
                spreadOffset = stored[spreadOffsetKey] === true
                spreadSeamless = stored[spreadSeamlessKey] === true
                // Per-series DB override wins, then the local per-title override, then global.
                direction =
                    libraryManga?.readingDirection ??
                    (dirOverride === "ltr" || dirOverride === "rtl" || dirOverride === "vertical"
                        ? dirOverride
                        : settings.readingDirection)
                pageFit = libraryManga?.pageFit ?? settings.pageFit
                showPageNumber = settings.showPageNumber
                spreadGapPx = settings.spreadGapPx ?? 8
                pageWidthPct = libraryManga?.pageWidthPct ?? settings.pageWidthPct ?? 100
                pageWidthOverride = libraryManga?.pageWidthPct ?? null
                noGapDefault = settings.noGapContinuous
                noGapOverride = libraryManga?.noGapContinuous ?? null
                noGapContinuous = libraryManga?.noGapContinuous ?? settings.noGapContinuous
                preloadPages = settings.preloadPages
            } catch {
                // keep defaults
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : "The chapter could not be loaded"
        } finally {
            resolving = false
        }
    }

    let unsubscribeLive: (() => void) | undefined
    let settingsListener: Parameters<typeof browser.storage.onChanged.addListener>[0] | undefined

    // Coalesces reader:progress runtime messages into a trailing 1s window so
    // rapid page onload events (e.g. scrolling a 100-page webtoon chapter)
    // don't spam a DB write + live-bus event per page. Recreated per chapter
    // load so a reporter never straddles two chapters' mangaId/chapterId.
    let progressReporter: ReturnType<typeof createProgressReporter> | undefined

    function createReporterForChapter(resolved: ResolvedChapter) {
        return createProgressReporter(
            payload =>
                void sendRuntimeMessage({
                    type: "reader:progress",
                    mangaId: resolved.manga.manga.id,
                    chapterId: resolved.chapter.id,
                    pageIndex: payload.pageIndex,
                    pageCount: resolved.pages.length,
                    completed: payload.completed
                })
        )
    }

    onMount(async () => {
        // A background chapter-list refresh (e.g. checkUpdates, or another tab
        // capturing a new chapter of this same manga) can complete while this
        // reader tab is already open - re-fetch siblings so next/prev picks it up
        // without needing a manual reload.
        unsubscribeLive = subscribeLive(["chapters"], ev => {
            if (chapter && (!ev.mangaIds || ev.mangaIds.includes(mangaId))) void loadSiblings(chapter)
        })
        // Settings live under a single storage.local "settings" key - watch it
        // directly instead of going through the live bus (see live.ts's module
        // comment on settings:update). Only the fields with no per-series override
        // path are safe to apply blindly; mode/direction/pageFit can be overridden
        // per-title and are left alone here to avoid clobbering an active override.
        settingsListener = (changes, area) => {
            if (area !== "local" || !changes["settings"]) return
            const next = changes["settings"].newValue as
                | Partial<{
                      showPageNumber: boolean
                      noGapContinuous: boolean
                      preloadPages: number
                      spreadGapPx: number
                      pageWidthPct: number
                  }>
                | undefined
            if (!next) return
            if (next.showPageNumber !== undefined) showPageNumber = next.showPageNumber
            if (next.preloadPages !== undefined) preloadPages = next.preloadPages
            if (next.noGapContinuous !== undefined) {
                noGapDefault = next.noGapContinuous
                if (noGapOverride === null) noGapContinuous = noGapDefault
            }
            // Both are global-only (no per-series override), so applying them live is safe -
            // dragging the Page-width / Double-page-gap slider updates an open reader instead
            // of waiting for a reload.
            if (next.spreadGapPx !== undefined) spreadGapPx = next.spreadGapPx
            if (next.pageWidthPct !== undefined && pageWidthOverride === null) pageWidthPct = next.pageWidthPct
        }
        browser.storage.onChanged.addListener(settingsListener)

        const params = new URL(location.href).searchParams
        const url = params.get("url")
        if (!url) {
            error = "No chapter URL was provided"
            return
        }
        chapterUrl = url
        await loadChapter(url)
        const pageParam = params.get("page")
        if (pageParam !== null) {
            const p = parseInt(pageParam)
            if (Number.isFinite(p) && p >= 0 && chapter && p < chapter.pages.length) currentPage = p
        }
    })

    onDestroy(() => {
        revokeOfflinePages()
        if (noGapSavedTimer) clearTimeout(noGapSavedTimer)
        unsubscribeLive?.()
        if (settingsListener) browser.storage.onChanged.removeListener(settingsListener)
    })

    function recordProgress(pageIndex: number) {
        if (!chapter) return
        // Unthrottled - drives the visible page-number UI and must stay instant.
        currentPage = pageIndex
        // Completed = the CURRENT VIEW shows the last page, not pageIndex === last: in double-page
        // mode the terminal nextStart is the start of the final PAIR (e.g. index 8 of a 10-page
        // chapter), so an exact-index check never fired and the chapter stayed "Started" forever.
        const view = spreadView(pageIndex, effectiveSpread, effectiveOffset, chapter.pages.length)
        const completed = view.indices.includes(chapter.pages.length - 1)
        progressReporter?.report(pageIndex, completed)
        // "Chapter finished" must reach the DB/live-bus immediately, not wait
        // out the trailing coalescing window.
        if (completed) progressReporter?.flush()
    }

    // Continuous mode drives progress from image onload, but eager-preloaded pages
    // fire onload before the reader has scrolled to them. Ignore those, and never let
    // an onload drag saved progress back below the page we resumed at.
    function recordContinuousProgress(pageIndex: number) {
        if (pageIndex < preloadPages) return
        if (pageIndex <= currentPage) return
        recordProgress(pageIndex)
    }

    function clearPageError(pageIndex: number) {
        if (!failedPages.has(pageIndex)) return
        const next = new Set(failedPages)
        next.delete(pageIndex)
        failedPages = next
    }

    function goToChapter(url: string | undefined) {
        if (!url) return
        // Flush while the old mangaId/chapterId are still the reporter's bound
        // identity - loadChapter() also flushes, but do it here too since this
        // is the scope that's "about to navigate away" from the old chapter.
        progressReporter?.flush()
        chapterUrl = url
        window.scrollTo(0, 0)
        void loadChapter(url)
    }

    // A8: mark the current chapter complete and jump to the next one.
    function markReadAndNext() {
        if (chapter && chapter.pages.length > 0) recordProgress(chapter.pages.length - 1)
        goToChapter(nextUrl)
    }

    function handleImageError(e: Event, pageIndex: number) {
        const img = e.currentTarget as HTMLImageElement
        console.warn("[AMR reader] Image error:", img.src)
        const isMangaDex = chapterUrl?.includes("mangadex.org") ?? false
        if (!img.dataset.didFallback && isMangaDex) {
            const match = img.src.match(/\/data\/([a-fA-F0-9]+)\/(.+?)(?:\?.*)?$/)
            if (match && match[1] && match[2]) {
                img.dataset.didFallback = "1"
                img.src = `https://uploads.mangadex.org/data/${match[1]}/${match[2]}`
                return
            }
        }
        // Transient failure (a rate-limited burst of parallel loads, or a flaky
        // rotating image host like mangak's rx.*.org) - retry a couple of times with a
        // short backoff before giving up, so a page doesn't strand on its "Page N" alt
        // text. Re-assigning src forces a fresh request. onload clears the counter.
        const retries = Number(img.dataset.retries ?? "0")
        if (retries < 2) {
            img.dataset.retries = String(retries + 1)
            const src = img.src
            setTimeout(
                () => {
                    if (!img.isConnected) return
                    img.src = ""
                    img.src = src
                },
                500 * (retries + 1)
            )
            return
        }
        console.warn("[AMR reader] Image load failed:", img.src)
        if (!failedPages.has(pageIndex)) {
            const next = new Set(failedPages)
            next.add(pageIndex)
            failedPages = next
        }
    }

    async function goToApp() {
        const appUrl = browser.runtime.getURL("/app.html")
        const currentTab = await browser.tabs.getCurrent().catch(() => undefined)
        // The reader always opens in a new tab, so the dashboard tab that launched it
        // is normally still alive in the background. Refocus it instead of cold-booting
        // a brand-new dashboard (which redoes onMount's full library load + cover backfill).
        try {
            const existing = await browser.tabs.query({ url: `${appUrl}*` })
            const existingTab = existing.find(t => t.id !== undefined)
            if (existingTab?.id !== undefined) {
                await browser.tabs.update(existingTab.id, { active: true })
                if (existingTab.windowId !== undefined) {
                    await browser.windows.update(existingTab.windowId, { focused: true })
                }
                if (currentTab?.id !== undefined) {
                    await browser.tabs.remove(currentTab.id)
                }
                return
            }
        } catch {
            // fallthrough to navigating the current tab
        }
        try {
            if (currentTab?.id !== undefined) {
                await browser.tabs.update(currentTab.id, { url: appUrl })
                return
            }
        } catch {
            // fallthrough
        }
        window.location.href = appUrl
    }
</script>

<svelte:window
    onkeydown={event => {
        if (!chapter) return
        // E2: keyboard-shortcut help overlay.
        if (event.key === "?") {
            showHelp = !showHelp
            return
        }
        if (event.key === "Escape" && showHelp) {
            showHelp = false
            return
        }
        // Immersion: toggle the top bar. Reveal-on-scroll-up and mouse-to-top always
        // bring it back too, so hiding can never strand the controls.
        if (event.key === "h" || event.key === "H") {
            chromeHidden = !chromeHidden
            return
        }
        if (event.key === "Escape" && chromeHidden) {
            chromeHidden = false
            return
        }
        // Chapter navigation works in any mode.
        if (event.key === "[") {
            goToChapter(prevUrl)
            return
        }
        if (event.key === "]") {
            goToChapter(nextUrl)
            return
        }
        if (effectiveMode !== "single") return
        // pageNav snaps to offset-aware boundaries (forward never re-shows the final page,
        // backward stays aligned) and resets scroll to the top of each flipped page.
        const key = event.key.toLowerCase()
        if (key === "j") pageNav("next")
        else if (key === "k") pageNav("prev")
        else if (event.key === "ArrowRight") pageNav(direction === "rtl" ? "prev" : "next")
        else if (event.key === "ArrowLeft") pageNav(direction === "rtl" ? "next" : "prev")
    }}
    onscroll={onScroll}
    onwheel={onWheel}
    onmousemove={event => {
        if (chromeHidden && event.clientY < 60) chromeHidden = false
    }}
    onpagehide={() => progressReporter?.flush()} />

<svelte:document
    onfullscreenchange={() => (isFullscreen = Boolean(document.fullscreenElement))}
    onvisibilitychange={() => {
        if (document.visibilityState === "hidden") progressReporter?.flush()
    }} />

<header class:chrome-hidden={chromeHidden}>
    <div class="header-left">
        <button type="button" class="btn-back" onclick={() => void goToApp()}>← Dash</button>
    </div>
    <div class="header-title">
        <strong>{chapter?.manga.manga.title ?? (resolving ? "Loading…" : "Reader")}</strong>
        {#if chapter}
            {#if siblings.length > 1}
                <select
                    class="chapter-select"
                    value={chapter.chapter.url}
                    onchange={e => goToChapter((e.currentTarget as HTMLSelectElement).value)}>
                    {#each siblings as s (s.url)}
                        <option value={s.url}>{s.title}</option>
                    {/each}
                </select>
                {#if currentIndex >= 0}
                    {@const cur = siblings[currentIndex]}
                    <span>
                        {cur && Number.isFinite(cur.sortKey)
                            ? `Chapter ${cur.sortKey}`
                            : `Chapter ${currentIndex + 1} of ${siblings.length}`}
                    </span>
                {/if}
            {:else}
                <span>{chapter.chapter.title}</span>
            {/if}
            {#if sourceDomain}
                <button
                    class="source-link"
                    type="button"
                    title="Open manga page on source site"
                    onclick={() => openExternal(sourceUrl)}>
                    {sourceDomain}
                </button>
            {/if}
            {#if sourceInfo?.supportUrl}
                <button
                    class="source-link kofi kofi-site"
                    type="button"
                    title="Support {sourceInfo.name} (this site's team) on {supportPlatform(sourceInfo.supportUrl)}"
                    onclick={() => openExternal(sourceInfo?.supportUrl)}>
                    ☕ {sourceInfo.name}
                </button>
            {/if}
            <button
                class="source-link kofi kofi-amr"
                type="button"
                title="Support {AMR_SUPPORT_LABEL} (this extension) on {supportPlatform(AMR_KOFI_URL)}"
                onclick={() => openExternal(AMR_KOFI_URL)}>
                ☕ {AMR_SUPPORT_LABEL}
            </button>
        {/if}
    </div>
    <div class="header-right">
        {#if chapter}
            {#if siblings.length > 1}
                <button
                    type="button"
                    class="btn-sm"
                    disabled={!prevUrl}
                    title="Previous chapter"
                    onclick={() => goToChapter(prevUrl)}>‹ Prev</button>
                <button
                    type="button"
                    class="btn-sm"
                    disabled={!nextUrl}
                    title="Next chapter"
                    onclick={() => goToChapter(nextUrl)}>Next ›</button>
            {/if}
            {#if viewMode === "single" || viewMode === "double"}
                <button
                    type="button"
                    class="btn-sm nav-page"
                    disabled={pageNavState.atStart}
                    title="Previous page"
                    aria-label="Previous page"
                    onclick={() => pageNav("prev", false)}>◀</button>
            {/if}
            <span class="page-count">{currentPage + 1} / {chapter.pages.length}</span>
            {#if viewMode === "single" || viewMode === "double"}
                <button
                    type="button"
                    class="btn-sm nav-page"
                    disabled={pageNavState.atEnd}
                    title="Next page"
                    aria-label="Next page"
                    onclick={() => pageNav("next", false)}>▶</button>
            {/if}
            <div class="seg" role="group" aria-label="View mode">
                <button
                    type="button"
                    class="seg-btn"
                    class:seg-active={viewMode === "strip"}
                    title="Strip: one continuous vertical scroll"
                    onclick={() => setView("strip")}>Strip</button>
                <button
                    type="button"
                    class="seg-btn"
                    class:seg-active={viewMode === "single"}
                    disabled={direction === "vertical"}
                    title={direction === "vertical"
                        ? "Vertical direction always scrolls as a strip"
                        : "Single: one page at a time"}
                    onclick={() => setView("single")}>Single</button>
                <button
                    type="button"
                    class="seg-btn"
                    class:seg-active={viewMode === "double"}
                    disabled={direction === "vertical"}
                    title={direction === "vertical"
                        ? "Vertical direction always scrolls as a strip"
                        : "Double: two-page spreads, flip with arrows or the wheel"}
                    onclick={() => setView("double")}>Double</button>
            </div>
            <button
                type="button"
                class="btn-sm"
                title="Cycle reading direction (LTR → RTL → Vertical)"
                onclick={cycleDirection}>
                {direction === "ltr" ? "→" : direction === "rtl" ? "←" : "↓"}
            </button>
            {#if viewMode === "double"}
                <button
                    type="button"
                    class="btn-sm"
                    class:active={spreadOffset}
                    title="Offset: show the first page (cover) alone, then pair the rest"
                    onclick={() => void setSpreadOffset(!spreadOffset)}>
                    Offset
                </button>
                <button
                    type="button"
                    class="btn-sm"
                    class:active={spreadSeamless}
                    title="Seamless: drop the centre gutter so a split spread's halves join"
                    onclick={() => void setSpreadSeamless(!spreadSeamless)}>
                    Seamless
                </button>
            {/if}
            {#if viewMode === "strip"}
                <button
                    type="button"
                    class="btn-sm"
                    class:active={noGapOverride === true}
                    class:off-override={noGapOverride === false}
                    title={noGapOverride === null
                        ? "Webtoon view (no gaps) - using the global default, click to set for this series"
                        : noGapOverride
                          ? "Webtoon view is ON for this series - click to turn off"
                          : "Webtoon view is OFF for this series - click to turn on"}
                    onclick={toggleSeriesNoGap}>
                    Webtoon view
                </button>
                {#if noGapOverride !== null}
                    <button
                        type="button"
                        class="reset-link"
                        title="Reset Webtoon view to the global default for this series"
                        aria-label="Reset Webtoon view to default"
                        onclick={resetSeriesNoGap}>×</button>
                {/if}
                {#if noGapSaved}<span class="saved-flash">✓ Saved</span>{/if}
            {/if}
        {/if}
        {#if chapter}
            <button
                type="button"
                class="btn-sm"
                class:active={fitOverride === "original"}
                title="Toggle zoom (or double-click a page)"
                onclick={toggleZoom}>⛶±</button>
            <button type="button" class="btn-sm" title="Fullscreen" onclick={() => void toggleFullscreen()}>
                {isFullscreen ? "⤢" : "⛶"}
            </button>
            {#if downloaded}
                <button
                    type="button"
                    class="btn-sm active"
                    disabled={removingDownload}
                    title="Available offline - click to remove"
                    onclick={() => void removeChapterDownload()}>
                    {removingDownload ? "…" : "✓ Offline"}
                </button>
            {:else}
                <button
                    type="button"
                    class="btn-sm"
                    disabled={downloading}
                    title="Download chapter for offline reading"
                    onclick={() => void downloadChapter()}>
                    {downloading ? "…" : "⬇"}
                </button>
            {/if}
            {#if downloaded}
                <button
                    type="button"
                    class="btn-sm"
                    disabled={exportingCbz}
                    title={exportCbzError || "Save this chapter as a CBZ file"}
                    onclick={() => void exportCbz()}>
                    {exportingCbz ? "…" : "CBZ ⤓"}
                </button>
                {#if exportCbzError}<span class="page-count">{exportCbzError}</span>{/if}
            {/if}
            <button
                type="button"
                class="btn-sm"
                class:active={showHelp}
                title="Keyboard shortcuts (?)"
                aria-label="Keyboard shortcuts"
                onclick={() => (showHelp = !showHelp)}>?</button>
            <button
                type="button"
                class="btn-sm"
                class:active={isBookmarked}
                title={isBookmarked ? "Remove bookmark for this page" : "Bookmark this page"}
                aria-label={isBookmarked ? "Remove bookmark" : "Bookmark page"}
                disabled={bookmarkWorking}
                onclick={() => void togglePageBookmark()}>
                {isBookmarked ? "★" : "☆"}
            </button>
            <button
                type="button"
                class="btn-sm"
                class:active={showCatPanel}
                title="Manage tags for this title"
                onclick={() => (showCatPanel = !showCatPanel)}>Tag</button>
        {/if}
        <button
            type="button"
            class="btn-sm"
            disabled={resolving || !chapterUrl}
            onclick={() => void loadChapter(chapterUrl)}>
            {resolving ? "…" : "↺"}
        </button>
    </div>
    {#if showCatPanel && chapter}
        <div class="cat-panel">
            <div class="cat-tags">
                {#each mangaCategories as tag}
                    <span class="cat-tag">
                        {tag}
                        <button
                            type="button"
                            class="cat-remove"
                            aria-label="Remove tag {tag}"
                            onclick={() => removeCategory(tag)}>×</button>
                    </span>
                {/each}
                {#if mangaCategories.length === 0}
                    <span class="cat-empty">No tags yet</span>
                {/if}
            </div>
            <form
                class="cat-form"
                onsubmit={e => {
                    e.preventDefault()
                    addCategory()
                }}>
                <input bind:value={catInput} placeholder="Add tag…" class="cat-input" aria-label="New tag name" />
                <button type="submit" class="btn-sm" disabled={catSaving || !catInput.trim()}>Add</button>
            </form>
        </div>
    {/if}
</header>

{#if chapter}
    <div class="progress-bar" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
        <div class="progress-fill" style="width:{progressPct}%"></div>
    </div>
{/if}

<main
    class:single={effectiveMode === "single"}
    class:no-gap={effectiveMode === "continuous" && noGapContinuous}
    class="fit-{effectivePageFit} dir-{direction}"
    style="--spread-gap: {spreadGapPx}px; --page-width: {pageWidthPct}%">
    {#if chapter && !error && !resolving && zeroPages}
        <div class="mirror-banner">
            <span>No reader pages available - open on site and use the StoryHoard sidebar to navigate.</span>
            <button type="button" class="btn-mirror" onclick={() => void openOnSiteAndTrack()}>
                Open on site &amp; mark read
            </button>
            <button type="button" class="btn-mirror" onclick={() => void findOnAnotherMirror()}>
                Find another source
            </button>
            {#if trackMessage}<span class="track-note">{trackMessage}</span>{/if}
        </div>
    {/if}
    {#if chapter && !error && !resolving && imagesBroken}
        <div class="mirror-banner">
            <span>Images not loading on this source?</span>
            <button type="button" class="btn-mirror" onclick={() => void openOnSiteAndTrack()}>
                Read on the site &amp; mark read
            </button>
            <button type="button" class="btn-mirror" onclick={() => void findOnAnotherMirror()}>
                Find another source
            </button>
            {#if trackMessage}<span class="track-note">{trackMessage}</span>{/if}
        </div>
    {/if}
    {#if error}
        <section class="message">
            {#if error.includes("not supported")}
                <h1>Site not supported in reader view</h1>
                <p>{error}</p>
                <p class="muted">
                    StoryHoard doesn't have a reader adapter for this site yet, but the
                    <strong>StoryHoard sidebar</strong> may still work - open the chapter normally and the sidebar lets you
                    track progress and navigate chapters while you read on the site.
                </p>
                {#if chapterUrl}
                    <button type="button" class="btn-mirror" onclick={() => void openOnSiteAndTrack()}>
                        Open on site (sidebar still works)
                    </button>
                {/if}
                <button type="button" class="btn-mirror" onclick={() => void findOnAnotherMirror()}>
                    Find this on a supported source
                </button>
                <p class="track-note">
                    Want this site added? Report it on
                    <a href="https://discord.gg/VKTvvg2sVJ" target="_blank" rel="noopener">Discord</a>
                    or
                    <a href="https://github.com/Ryuu3rs/storyhoard-extension/issues" target="_blank" rel="noopener"
                        >GitHub</a
                    >.
                </p>
            {:else}
                <h1>Chapter could not be loaded</h1>
                <p>{error}</p>
                <p class="muted">
                    The site may be temporarily down or blocking requests. Try again in a moment, or read directly on
                    the site - the <strong>StoryHoard sidebar</strong> will still let you track your progress and navigate
                    chapters.
                </p>
                {#if chapterUrl}
                    <button type="button" onclick={() => void loadChapter(chapterUrl)}>Try again</button>
                    <button type="button" class="btn-mirror" onclick={() => void openOnSiteAndTrack()}>
                        Open on site (sidebar still works)
                    </button>
                {/if}
                <button type="button" class="btn-mirror" onclick={() => void findOnAnotherMirror()}>
                    Find this on another source
                </button>
                <p class="track-note">
                    Still broken? Report it on
                    <a href="https://discord.gg/VKTvvg2sVJ" target="_blank" rel="noopener">Discord</a>
                    or
                    <a href="https://github.com/Ryuu3rs/storyhoard-extension/issues" target="_blank" rel="noopener"
                        >GitHub</a
                    >.
                </p>
            {/if}
            {#if trackMessage}<p class="track-note">{trackMessage}</p>{/if}
        </section>
    {:else if resolving}
        <section class="message"><p>Loading chapter…</p></section>
    {:else if !chapter}
        <section class="message"><p>No chapter loaded.</p></section>
    {:else if effectiveMode === "single" && !imagesBroken}
        <div
            class="page"
            class:spread={spreadIndices.length > 1}
            class:seamless={effectiveSeamless && spreadIndices.length > 1}>
            {#each spreadIndices as p (p)}
                <img
                    src={pageSrcs[p]}
                    alt={`Page ${p + 1}`}
                    ondblclick={toggleZoom}
                    onerror={e => handleImageError(e, p)}
                    onload={e => {
                        delete (e.currentTarget as HTMLImageElement).dataset.didFallback
                        delete (e.currentTarget as HTMLImageElement).dataset.retries
                        clearPageError(p)
                        recordProgress(currentPage)
                    }} />
            {/each}
            {#if showPageNumber}
                <span class="page-num">{spreadIndices[0]! + 1} / {chapter.pages.length}</span>
            {/if}
        </div>
    {:else if !imagesBroken}
        {#each pageSrcs as src, index}
            <div class="page">
                <img
                    {src}
                    alt={`Page ${index + 1}`}
                    loading={index < preloadPages ? "eager" : "lazy"}
                    ondblclick={toggleZoom}
                    onerror={e => handleImageError(e, index)}
                    onload={e => {
                        delete (e.currentTarget as HTMLImageElement).dataset.didFallback
                        delete (e.currentTarget as HTMLImageElement).dataset.retries
                        clearPageError(index)
                        recordContinuousProgress(index)
                    }} />
                {#if showPageNumber}<span class="page-num">{index + 1} / {chapter.pages.length}</span>{/if}
            </div>
        {/each}
    {/if}
</main>

{#if chapter && !error && !resolving && (nextUrl || prevUrl)}
    <footer class="chapter-nav">
        <button type="button" class="btn-sm" disabled={!prevUrl} onclick={() => goToChapter(prevUrl)}>
            ‹ Previous chapter
        </button>
        <button type="button" class="nav-primary" disabled={!nextUrl} onclick={() => markReadAndNext()}>
            {nextUrl ? "Mark read & next ›" : "Next chapter ›"}
        </button>
    </footer>
{/if}

{#if showHelp}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="help-backdrop" onclick={() => (showHelp = false)}>
        <div
            class="help-card"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            tabindex="-1"
            onclick={event => event.stopPropagation()}>
            <div class="help-head">
                <h2>Keyboard shortcuts</h2>
                <button type="button" class="help-close" aria-label="Close" onclick={() => (showHelp = false)}
                    >×</button>
            </div>
            <div class="help-list">
                <div class="shortcut-row">
                    <span class="keys"><kbd>j</kbd> / <kbd>k</kbd></span>
                    <span class="label">Next / previous page</span>
                </div>
                <div class="shortcut-row">
                    <span class="keys"><kbd>←</kbd> / <kbd>→</kbd></span>
                    <span class="label">Previous / next page (direction-aware, respects RTL)</span>
                </div>
                <div class="shortcut-row">
                    <span class="keys"><kbd>[</kbd> / <kbd>]</kbd></span>
                    <span class="label">Previous / next chapter</span>
                </div>
                <div class="shortcut-row">
                    <span class="keys"><kbd>h</kbd></span>
                    <span class="label">Hide / show the top bar (or move the mouse to the top edge)</span>
                </div>
                <div class="shortcut-row">
                    <span class="keys"><kbd>?</kbd></span>
                    <span class="label">Toggle this help</span>
                </div>
                <div class="shortcut-row">
                    <span class="keys"><kbd>Esc</kbd></span>
                    <span class="label">Close help</span>
                </div>
                <div class="shortcut-row">
                    <span class="keys">Double-click</span>
                    <span class="label">Toggle zoom on a page (fit ↔ original)</span>
                </div>
            </div>
            <p class="help-note">
                Page keys (<kbd>j</kbd>/<kbd>k</kbd>, arrows) and the on-screen <kbd>◀</kbd>/<kbd>▶</kbd> buttons apply in
                Single view. Strip and Double scroll. Chapter keys work in any mode.
            </p>
            <button type="button" class="help-got-it" onclick={() => (showHelp = false)}>Got it</button>
        </div>
    </div>
{/if}

{#if mirrorOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="help-backdrop" onclick={() => (mirrorOpen = false)}>
        <div
            class="help-card mirror-card"
            role="dialog"
            aria-modal="true"
            aria-label="Find another source"
            tabindex="-1"
            onclick={event => event.stopPropagation()}>
            <div class="help-head">
                <h2>Find another source</h2>
                <button type="button" class="help-close" aria-label="Close" onclick={() => (mirrorOpen = false)}
                    >×</button>
            </div>
            {#if mirrorLoading}
                <p class="muted">Searching other sources…</p>
            {:else if mirrorSearched && mirrorResults.length === 0}
                <p class="muted">
                    {mirrorQuery ? "No other mirror found for this title." : "Couldn't work out a title to search for."}
                </p>
            {:else if mirrorResults.length > 0}
                <p class="help-note">Results for “{mirrorQuery}” from other sources:</p>
                <div class="mirror-groups">
                    {#each mirrorResultsBySource as [sourceId, results] (sourceId)}
                        <div class="mirror-group">
                            <h3 class="mirror-source">{sourceId}</h3>
                            {#each results as result (result.url)}
                                <div class="mirror-result">
                                    <div class="mirror-meta">
                                        <span class="mirror-title">{result.title}</span>
                                        {#if result.latestChapter}
                                            <span class="muted">Latest: {result.latestChapter}</span>
                                        {/if}
                                    </div>
                                    <button type="button" class="btn-sm" onclick={() => openMirror(result)}>
                                        Open
                                    </button>
                                </div>
                            {/each}
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    .btn-mirror {
        margin-top: 16px;
        background: #f59e0b;
        border: 1px solid #d97706;
        color: #1a1a1a;
        font-weight: 600;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
    }

    .track-note {
        margin-top: 10px;
        font-size: 13px;
        opacity: 0.85;
    }

    .mirror-banner {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        flex-wrap: wrap;
        margin: 16px auto;
        padding: 12px 16px;
        max-width: 560px;
        border: 1px solid #d97706;
        border-radius: 8px;
        background: rgba(245, 158, 11, 0.12);
        color: #fbbf24;
    }

    .mirror-banner .btn-mirror {
        margin-top: 0;
    }

    .mirror-card {
        text-align: left;
    }

    .mirror-groups {
        display: flex;
        flex-direction: column;
        gap: 16px;
        margin-top: 12px;
        max-height: 50vh;
        overflow-y: auto;
    }

    .mirror-source {
        margin: 0 0 6px;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        opacity: 0.7;
    }

    .mirror-result {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .mirror-meta {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .mirror-title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .kofi {
        white-space: nowrap;
    }
    .kofi-site {
        color: #fde68a;
        border-color: rgba(250, 204, 21, 0.45);
    }
    .kofi-amr {
        color: #c7d2fe;
        border-color: rgba(99, 102, 241, 0.6);
    }
</style>
