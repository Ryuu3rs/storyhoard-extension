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
