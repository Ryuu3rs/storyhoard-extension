// ARCHITECTURE TRACK A - experimental, dev-demo only.
//
// A bundled sample profile used ONLY to demonstrate the engine end to end in a dev build
// (arch flag on). It points at a LOCAL sample source served on http://localhost:8891 - a
// legal, self-authored sample, deliberately not any third-party site. In the real product a
// user would import a profile of exactly this shape; nothing here ships to users.

import type { SiteProfile } from "./profile-schema"

export const DEMO_ORIGIN = "http://localhost:8891"

export const demoProfiles: readonly SiteProfile[] = [
    {
        profileFormat: 1,
        id: "arch-demo-sample",
        name: "Sample Library (Arch A)",
        engine: "generic",
        origin: DEMO_ORIGIN,
        domains: ["localhost"],
        languages: ["en"],
        capabilities: ["pages", "chapters", "manga"],
        requestRateLimit: { requests: 5, intervalMs: 1000 },
        origins: [`${DEMO_ORIGIN}/*`],
        match: {
            manga: "^/manga/([a-z0-9-]+)/?$",
            chapter: "^/manga/([a-z0-9-]+)/ch-([0-9.]+)/?$"
        },
        series: {
            urlTemplate: "/manga/{slug}/",
            titlePattern: '<meta property="og:title" content="(?<title>[^"]+)"',
            coverPattern: '<meta property="og:image" content="(?<cover>[^"]+)"'
        },
        list: {
            itemPattern:
                '<a class="chapter" href="(?<chapterUrl>/manga/[a-z0-9-]+/ch-(?<chapterNumber>[0-9.]+)/)">(?<chapterTitle>[^<]*)</a>'
        },
        pages: {
            imagePatterns: ['<img class="page" src="(?<url>[^"]+)"']
        },
        search: {
            urlTemplate: "/search/?q={query}",
            itemPattern: '<a class="result" href="(?<url>[^"]+)"[^>]*data-cover="(?<cover>[^"]*)">(?<title>[^<]+)</a>'
        }
    }
]

export const demoOrigins: readonly string[] = [`${DEMO_ORIGIN}/*`]

// A profile for a REAL already-working bundled source (MangaFreak), authored from its live
// HTML, to test the engine against a real site. Used to disable the bundled adapter and run the
// same site as a user-supplied profile. Origins are already in permissions.ts, so no manifest
// change is needed. Mirror rotates (ww2 -> ww3 -> ...), which a static-origin profile cannot
// follow - a real limitation worth noting.
export const mangafreakProfile: SiteProfile = {
    profileFormat: 1,
    id: "mangafreak",
    name: "MangaFreak (profile)",
    engine: "generic",
    origin: "https://ww3.mangafreak.me",
    domains: ["ww3.mangafreak.me", "ww2.mangafreak.me", "ww1.mangafreak.me", "mangafreak.me"],
    languages: ["en"],
    capabilities: ["pages", "chapters", "manga"],
    requestRateLimit: { requests: 3, intervalMs: 1000 },
    origins: ["*://*.mangafreak.me/*", "*://*.images.mangafreak.me/*"],
    imageOrigins: ["*://*.images.mangafreak.me/*"],
    match: {
        manga: "^/Manga/([A-Za-z0-9_]+)/?$",
        chapter: "^/Read1_(.+?)_([0-9.]+)/?$"
    },
    series: {
        urlTemplate: "/Manga/{slug}",
        titlePattern: 'property="og:title" content="(?<title>.+?) Manga Chapter List',
        coverPattern: 'property="og:image" content="(?<cover>[^"]+)"'
    },
    list: {
        itemPattern: 'href="(?<chapterUrl>/Read1_.+?_(?<chapterNumber>[0-9.]+))"'
    },
    pages: {
        imagePatterns: [
            '<img[^>]+src="(?<url>https?://[^"]*images\\.mangafreak\\.me/mangas/[^"]+)"',
            '<img[^>]+data-src="(?<url>https?://[^"]*mangafreak\\.me/mangas/[^"]+)"'
        ]
    },
    search: {
        urlTemplate: "/Find/{query}",
        itemPattern: '<h3>\\s*<a href="(?<url>/Manga/[A-Za-z0-9_]+)">(?<title>[^<]+)</a>'
    }
}
