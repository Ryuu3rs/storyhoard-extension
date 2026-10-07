// Build-time definition of the one-time migration seed: ONE format-2 Site Profile per
// currently-shipped bundled source id (profile.id === sourceId), so that when a bundled
// adapter is removed in a later release the library rows that point at it still resolve
// (getSourceById) and stay trackable instead of silently going dead.
//
// Nothing here runs in the shipped extension. `scripts/generate-migration-seed.ts` calls
// buildSeedProfiles() and writes packages/sources/migration-seed.json; the runtime only reads
// that committed JSON (see seed-register.ts). A drift test fails if the JSON and this module
// disagree, so the file is always reproducible.
//
// Derivation rules (kept honest by migration-seed.test.ts, which diffs every profile's
// match()/parseMangaUrl() against the real adapter over a URL corpus):
//   * Config-row families (madara / mangastream / fanfox / mangabuddy): match + series are
//     built MECHANICALLY from the same regex construction the factory uses, from the factory's
//     own config rows, so recognition is lossless by construction.
//   * Bespoke adapters: regexes are transcribed from the adapter's own match()/parseMangaUrl,
//     with JS regex flags (`i`) expanded into explicit character classes (a profile regex is a
//     bare string, it cannot carry flags).
//   * `list` is emitted ONLY where the chapter list is a plain GET + regex AND the markup is
//     structurally scoped to the series (Madara `wp-manga-chapter` rows, MangaStream
//     `data-num` rows). A slug-agnostic list regex over a page that also carries related-series
//     chapter links would invent foreign chapters and fire false "new chapter" notifications,
//     so every other source is RECOGNITION-ONLY (match + series, no list): the library row
//     keeps resolving and is tracked from the user's own tab, but nothing is fetched to list it.
//   * Sources that need a token / nonce / challenge / RSC to be read are inexpressible by
//     design (profile-schema.ts bans those fields - the DMCA 1201 line) and are recognition-only.
//     This module never adds any such field.

import {
    fanfoxFamilySiteConfigs,
    madaraSiteConfigs,
    mangaBuddySiteConfigs,
    mangaStreamSiteConfigs,
    mangareadConfig,
    sourceAdapters
} from "@amr/sources"
import type { FanfoxFamilyConfig, MadaraConfig, MangaBuddyConfig, MangaStreamConfig } from "@amr/sources"
import { PROFILE_FORMAT_2, type SiteProfile } from "@amr/source-engine"
import type { SourceManifest } from "@amr/source-sdk"

// A URL plus what the profile must say about it: the series id parseMangaUrl yields (or null
// when the URL carries no series id, e.g. a chapter URL that does not embed the series).
export type SeedSample = { url: string; mangaId: string | null }

export type SeedEntry = {
    profile: SiteProfile
    // Hand-checked corpus for bespoke sources. Family rows get a generated corpus (familySamples).
    samples: readonly SeedSample[]
}

const OG_TITLE = '<meta[^>]+property="og:title"[^>]+content="(?<title>[^"]+)"'
const OG_IMAGE = '<meta[^>]+property="og:image"[^>]+content="(?<cover>[^"]+)"'
const HTML_TITLE = "<title>(?<title>.+?)(?:\\s+[-|]\\s+[^<]*)?</title>"

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Expand a word into a case-insensitive character-class sequence (profile regexes carry no flags).
function ci(word: string): string {
    return [...word].map(c => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escapeRegex(c))).join("")
}

function originPatterns(manifest: SourceManifest): string[] {
    const own = manifest.domains.map(d => (d.startsWith("*.") ? `*://${d}/*` : `https://${d}/*`))
    return [...new Set([...own, ...(manifest.imageOrigins ?? [])])]
}

function manifestOf(id: string): SourceManifest {
    const adapter = sourceAdapters.find(a => a.manifest.id === id)
    if (!adapter) throw new Error(`migration seed: no bundled adapter with id "${id}"`)
    return adapter.manifest
}

type ProfileParts = {
    origin?: string
    match: SiteProfile["match"]
    series: SiteProfile["series"]
    list?: SiteProfile["list"]
}

function profileFor(id: string, parts: ProfileParts): SiteProfile {
    const manifest = manifestOf(id)
    return {
        profileFormat: PROFILE_FORMAT_2,
        id,
        name: manifest.name,
        engine: "generic",
        numberingKind: "chapter",
        origin: parts.origin ?? manifest.homepage ?? `https://${manifest.domains[0]}`,
        domains: [...manifest.domains],
        languages: [...manifest.languages],
        capabilities: parts.list ? ["manga", "chapters"] : ["manga"],
        requestRateLimit: { ...manifest.requestRateLimit },
        origins: originPatterns(manifest),
        match: parts.match,
        series: parts.series,
        ...(parts.list ? { list: parts.list } : {})
    }
}

function sampleHost(domains: readonly string[]): string {
    const first = domains[0] ?? "example.test"
    return first.startsWith("*.") ? `ww9.${first.slice(2)}` : first
}

// ---------------------------------------------------------------------------------------------
// Families (derived mechanically from the factory configs)
// ---------------------------------------------------------------------------------------------

function madaraEntry(config: MadaraConfig): SeedEntry {
    const mangaPath = config.mangaPath ?? "manga"
    const chapterPrefix = config.chapterPrefix ?? "chapter"
    const paths = [mangaPath, ...(config.altMangaPaths ?? [])].map(escapeRegex).join("|")
    const prefix = escapeRegex(chapterPrefix)
    const volume = config.volumePath ? "(?:vol(?:ume)?[-_][^/]+/)?" : ""
    // Same shape as madara.ts's chapterRe `(${prefix}[^/]+)` (>=1 char after the prefix), with the
    // chapter NUMBER lifted into capture group 2 (engine contract) via an optional `-N` that does
    // not change which paths match.
    const chapter = `^/(?:${paths})/([^/]+)/${volume}${prefix}(?=[^/])(?:-(\\d+(?:[.-]\\d+)?))?[^/]*(?:/|$)`
    const manga = `^/(?:${paths})/([^/]+)/?$`
    const profile = profileFor(config.id, {
        origin: config.origin,
        match: { manga, chapter },
        series: {
            urlTemplate: `/${mangaPath}/{slug}/`,
            titlePattern: HTML_TITLE,
            coverPattern: OG_IMAGE
        },
        // Structurally scoped: only rows of the series' own chapter list carry wp-manga-chapter.
        list: {
            itemPattern: `<li[^>]*\\bwp-manga-chapter\\b[^>]*>\\s*<a\\s+href="(?<chapterUrl>[^"]*${prefix}-(?<chapterNumber>\\d+(?:[.-]\\d+)?)[^"]*)"`
        }
    })
    return { profile, samples: madaraSamples(config) }
}

function madaraSamples(config: MadaraConfig): SeedSample[] {
    const host = sampleHost(config.domains)
    const mangaPath = config.mangaPath ?? "manga"
    const prefix = config.chapterPrefix ?? "chapter"
    const base = `https://${host}`
    const out: SeedSample[] = [
        { url: `${base}/${mangaPath}/some-title/`, mangaId: "some-title" },
        { url: `${base}/${mangaPath}/some-title`, mangaId: "some-title" },
        { url: `${base}/${mangaPath}/some-title/${prefix}-12/`, mangaId: "some-title" },
        { url: `${base}/${mangaPath}/some-title/${prefix}-12-5/`, mangaId: "some-title" },
        { url: `${base}/${mangaPath}/some-title/${prefix}-extra/`, mangaId: "some-title" },
        { url: `${base}/${mangaPath}/some-title/${prefix}-1`, mangaId: "some-title" },
        {
            url: `${base}/${mangaPath}/some-title/volume-9/${prefix}-71/`,
            mangaId: config.volumePath ? "some-title" : null
        },
        { url: `${base}/${mangaPath}/some-title/${prefix}/`, mangaId: null },
        { url: `${base}/${mangaPath}/`, mangaId: null },
        { url: `${base}/`, mangaId: null },
        { url: `${base}/genre/action/`, mangaId: null },
        { url: `https://unrelated.example/${mangaPath}/some-title/`, mangaId: null }
    ]
    for (const alt of config.altMangaPaths ?? []) {
        out.push({ url: `${base}/${alt}/some-title/`, mangaId: "some-title" })
        out.push({ url: `${base}/${alt}/some-title/${prefix}-3/`, mangaId: "some-title" })
    }
    return out
}

function mangaStreamEntry(config: MangaStreamConfig): SeedEntry {
    const mangaPath = config.mangaPath ?? "manga"
    const paths = escapeRegex(mangaPath)
    const hierarchical = config.chapterFormat === "hierarchical"
    const manga = `^/${paths}/([^/]+)/?$`
    // Flat chapter URLs are a bare root slug that does NOT contain the series slug, so the
    // regex is deliberately capture-free: it recognises the page but yields no series id, same
    // as the factory's parseMangaUrl returning null for it.
    const chapter = hierarchical
        ? `^/${paths}/([^/]+)/(\\d+(?:[.-]\\d+)?)/?$`
        : "^/[a-zA-Z0-9][a-zA-Z0-9._-]*chapter[a-zA-Z0-9._-]*/?$"
    const itemPattern = hierarchical
        ? `<li[^>]*\\bdata-num=["'][^"']*["'][^>]*>\\s*<a\\s+href="(?<chapterUrl>[^"]*/${paths}/[^/"]+/(?<chapterNumber>\\d+(?:[.-]\\d+)?)/?)"`
        : `<li[^>]*\\bdata-num=["'][^"']*["'][^>]*>\\s*<a\\s+href="(?<chapterUrl>[^"]*chapter[-_ ]?(?<chapterNumber>\\d+(?:[.-]\\d+)?)[^"]*)"`
    const profile = profileFor(config.id, {
        origin: config.origin,
        match: { manga, chapter },
        series: { urlTemplate: `/${mangaPath}/{slug}/`, titlePattern: HTML_TITLE, coverPattern: OG_IMAGE },
        list: { itemPattern }
    })
    const host = sampleHost(config.domains)
    const base = `https://${host}`
    const samples: SeedSample[] = [
        { url: `${base}/${mangaPath}/some-title/`, mangaId: "some-title" },
        { url: `${base}/${mangaPath}/some-title`, mangaId: "some-title" },
        { url: `${base}/${mangaPath}/`, mangaId: null },
        { url: `${base}/`, mangaId: null },
        { url: `https://unrelated.example/${mangaPath}/some-title/`, mangaId: null },
        hierarchical
            ? { url: `${base}/${mangaPath}/some-title/12/`, mangaId: "some-title" }
            : { url: `${base}/some-title-chapter-12/`, mangaId: null },
        hierarchical
            ? { url: `${base}/${mangaPath}/some-title/12-5`, mangaId: "some-title" }
            : { url: `${base}/some-title-chapter-12-5`, mangaId: null }
    ]
    return { profile, samples }
}

function fanfoxEntry(config: FanfoxFamilyConfig): SeedEntry {
    const profile = profileFor(config.id, {
        origin: config.origin,
        match: {
            manga: "^/manga/([^/]+)/?$",
            chapter: "^/manga/([^/]+)/(?:v[^/]+/)?c([^/]+?)(?:/\\d+\\.html)?/?$"
        },
        series: { urlTemplate: "/manga/{slug}/", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
    })
    const base = `https://${sampleHost(config.domains)}`
    return {
        profile,
        samples: [
            { url: `${base}/manga/some_title/`, mangaId: "some_title" },
            { url: `${base}/manga/some_title`, mangaId: "some_title" },
            { url: `${base}/manga/some_title/c012/`, mangaId: "some_title" },
            { url: `${base}/manga/some_title/c012/1.html`, mangaId: "some_title" },
            { url: `${base}/manga/some_title/v02/c012.5/3.html`, mangaId: "some_title" },
            { url: `${base}/`, mangaId: null },
            { url: `${base}/directory/`, mangaId: null },
            { url: `https://unrelated.example/manga/some_title/`, mangaId: null }
        ]
    }
}

function mangaBuddyEntry(config: MangaBuddyConfig): SeedEntry {
    // No MangaBuddy site is currently active (the config array is empty), so this never runs; it
    // exists so a re-enabled row cannot ship without a seed profile (the coverage test would fail).
    throw new Error(`migration seed: no mangabuddy profile builder yet for "${config.id}"`)
}

// ---------------------------------------------------------------------------------------------
// Bespoke adapters (transcribed from each adapter's own match()/parseMangaUrl)
// ---------------------------------------------------------------------------------------------

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const ULID = "[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}"
const MANGAK_RESERVED = [
    "home",
    "about",
    "dmca",
    "contact",
    "search",
    "trending",
    "static",
    "_next",
    "api",
    "login",
    "register",
    "genres",
    "genre"
]

const KAGANE_SERIES = "0b6c7a1e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"
const KAGANE_CHAPTER = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a"
const ULID_SERIES = "01HV3K9MXNP2Q4R6S8T0V2W4Y6"
const ULID_CHAPTER = "01HV3K9MXNP2Q4R6S8T0V2W4Z9"

function mangakAlt(): string {
    return MANGAK_RESERVED.map(ci).join("|")
}

function bespokeEntries(): SeedEntry[] {
    const entries: SeedEntry[] = []
    const add = (id: string, parts: ProfileParts, samples: readonly SeedSample[]): void => {
        entries.push({ profile: profileFor(id, parts), samples })
    }

    add(
        "kagane",
        {
            match: {
                manga: `^/series/(${UUID})/?$`,
                chapter: `^/series/(${UUID})/reader/(${UUID})/?$`
            },
            series: { urlTemplate: "/series/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: `https://kagane.to/series/${KAGANE_SERIES}`, mangaId: KAGANE_SERIES },
            { url: `https://kagane.to/series/${KAGANE_SERIES}/`, mangaId: KAGANE_SERIES },
            { url: `https://kagane.to/series/${KAGANE_SERIES}/reader/${KAGANE_CHAPTER}`, mangaId: KAGANE_SERIES },
            { url: "https://kagane.to/series/not-a-uuid", mangaId: null },
            { url: "https://kagane.to/series", mangaId: null },
            { url: `https://other.example/series/${KAGANE_SERIES}`, mangaId: null }
        ]
    )

    add(
        "mangadex",
        {
            match: {
                manga: `^(?:/[^/]+)*?/title/(${UUID})(?:/|$)`,
                chapter: `^(?:/[^/]+)*?/chapter/${UUID}(?:/|$)`
            },
            series: { urlTemplate: "/title/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: `https://mangadex.org/title/${KAGANE_SERIES}`, mangaId: KAGANE_SERIES },
            { url: `https://mangadex.org/title/${KAGANE_SERIES}/some-slug`, mangaId: KAGANE_SERIES },
            { url: `https://www.mangadex.org/title/${KAGANE_SERIES}`, mangaId: KAGANE_SERIES },
            { url: `https://mangadex.org/chapter/${KAGANE_CHAPTER}`, mangaId: null },
            { url: `https://mangadex.org/chapter/${KAGANE_CHAPTER}/3`, mangaId: null },
            { url: "https://mangadex.org/title/not-a-uuid", mangaId: null },
            { url: "https://mangadex.org/", mangaId: null }
        ]
    )

    add(
        "mgeko",
        {
            match: {
                manga: "^/manga/([^/]+)/?$",
                // Any /reader/en/<slug> is a chapter (as in the adapter); the series slug is captured
                // only when the slug has the `<series>-chapter-<n>` shape, so a chapter URL that does
                // not embed a series yields no series id (adapter: parseChapterSlug fallback).
                chapter: "^/reader/en/(?:([^/]*)-chapter-(\\d+(?:-\\d+)?)(?:-[^/]*)?|[^/]+)/?$"
            },
            series: { urlTemplate: "/manga/{slug}/", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://www.mgeko.cc/manga/barbarians-adventure/", mangaId: "barbarians-adventure" },
            { url: "https://mgeko.cc/manga/barbarians-adventure", mangaId: "barbarians-adventure" },
            {
                url: "https://www.mgeko.cc/reader/en/barbarians-adventure-chapter-52-eng-li/",
                mangaId: "barbarians-adventure"
            },
            {
                url: "https://www.mgeko.cc/reader/en/barbarians-adventure-chapter-52-5-eng-li/",
                mangaId: "barbarians-adventure"
            },
            { url: "https://www.mgeko.cc/reader/en/barbarians-adventure-chapter-52", mangaId: "barbarians-adventure" },
            { url: "https://www.mgeko.cc/reader/en/some-oneshot/", mangaId: null },
            { url: "https://www.mgeko.cc/reader/fr/barbarians-adventure-chapter-52/", mangaId: null },
            { url: "https://www.mgeko.cc/", mangaId: null }
        ]
    )

    add(
        "weebcentral",
        {
            match: {
                manga: `^/series/(${ULID})(?:/[^/]*)?/?$`,
                // The chapter URL carries only the chapter id, never the series: capture-free.
                chapter: `^/chapters/${ULID}(?:/.*)?$`
            },
            series: { urlTemplate: "/series/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: `https://weebcentral.com/series/${ULID_SERIES}`, mangaId: ULID_SERIES },
            { url: `https://weebcentral.com/series/${ULID_SERIES}/solo-leveling`, mangaId: ULID_SERIES },
            { url: `https://www.weebcentral.com/series/${ULID_SERIES}/solo-leveling/`, mangaId: ULID_SERIES },
            { url: `https://weebcentral.com/chapters/${ULID_CHAPTER}`, mangaId: null },
            { url: `https://weebcentral.com/chapters/${ULID_CHAPTER}/images`, mangaId: null },
            { url: "https://weebcentral.com/series/short", mangaId: null },
            { url: "https://weebcentral.com/", mangaId: null }
        ]
    )

    add(
        "dynasty-scans",
        {
            match: {
                manga: "^/series/([a-zA-Z0-9_-]+)/?$",
                chapter: "^/chapters/[a-zA-Z0-9_-]+/?$"
            },
            series: { urlTemplate: "/series/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://dynasty-scans.com/series/some_title", mangaId: "some_title" },
            { url: "https://www.dynasty-scans.com/series/some_title/", mangaId: "some_title" },
            { url: "https://dynasty-scans.com/chapters/some_title_ch01", mangaId: null },
            { url: "https://dynasty-scans.com/chapters/some_title_ch01/", mangaId: null },
            { url: "https://dynasty-scans.com/series/some/deep", mangaId: null },
            { url: "https://dynasty-scans.com/", mangaId: null }
        ]
    )

    add(
        "asurascans",
        {
            match: {
                manga: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/?$",
                chapter: "^/comics/([a-zA-Z0-9][a-zA-Z0-9-]*)/chapter/(\\d+(?:[.-]\\d+)?)/?$"
            },
            series: { urlTemplate: "/comics/{slug}/", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://asurascans.com/comics/solo-leveling-1a2b3c4d", mangaId: "solo-leveling-1a2b3c4d" },
            { url: "https://asurascans.com/comics/solo-leveling-1a2b3c4d/", mangaId: "solo-leveling-1a2b3c4d" },
            {
                url: "https://asurascans.com/comics/solo-leveling-1a2b3c4d/chapter/12",
                mangaId: "solo-leveling-1a2b3c4d"
            },
            {
                url: "https://asurascans.com/comics/solo-leveling-1a2b3c4d/chapter/12.5/",
                mangaId: "solo-leveling-1a2b3c4d"
            },
            { url: "https://asurascans.com/comics/solo-leveling-1a2b3c4d/chapter/x", mangaId: null },
            { url: "https://asurascans.com/", mangaId: null }
        ]
    )

    // Identity here is the `title_no` QUERY parameter, which a path-only profile cannot capture,
    // so this profile is a best-effort path shape. WEBTOON is a Tier-1 legit source that stays
    // bundled for good; the register routine never seeds it (see seed-register.ts) and the parity
    // test exempts it.
    add(
        "webtoons",
        {
            match: {
                manga: "^/[a-z]{2}(?:-[a-zA-Z]+)?/[^/]+/([^/]+)/list/?$",
                chapter: "^/[a-z]{2}(?:-[a-zA-Z]+)?/[^/]+/[^/]+/[^/]+/viewer/?$"
            },
            series: { titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        []
    )

    add(
        "mangahub",
        {
            match: {
                manga: "^/manga/([^/]+)/?$",
                // chapter slug is `<series>[_<n>]`; strip the optional numeric suffix like parseMangaUrl.
                chapter: "^/chapter/([^/]+?)(?:_\\d+)?/chapter-(\\d+(?:\\.\\d+)?)?.*$"
            },
            series: { urlTemplate: "/manga/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://mangahub.io/manga/solo-leveling", mangaId: "solo-leveling" },
            { url: "https://www.mangahub.io/manga/solo-leveling/", mangaId: "solo-leveling" },
            { url: "https://mangahub.io/chapter/solo-leveling_105/chapter-105", mangaId: "solo-leveling" },
            { url: "https://mangahub.io/chapter/solo-leveling/chapter-3.5", mangaId: "solo-leveling" },
            { url: "https://mangahub.io/", mangaId: null }
        ]
    )

    add(
        "olympustaff",
        {
            match: {
                manga: "^/series/([^/]+)/?$",
                chapter: "^/series/([^/]+)/(\\d+(?:\\.\\d+)?)/?$"
            },
            series: { urlTemplate: "/series/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://olympustaff.com/series/eternal-club", mangaId: "eternal-club" },
            { url: "https://www.olympustaff.com/series/eternal-club/", mangaId: "eternal-club" },
            { url: "https://olympustaff.com/series/eternal-club/54", mangaId: "eternal-club" },
            { url: "https://olympustaff.com/series/eternal-club/54.5/", mangaId: "eternal-club" },
            { url: "https://olympustaff.com/series/eternal-club/abc", mangaId: null },
            { url: "https://olympustaff.com/series", mangaId: null }
        ]
    )

    add(
        "mangafreak",
        {
            match: {
                manga: "^/Manga/([A-Za-z0-9_]+)/?$",
                chapter: "^/Read1_(.+)_(\\d+(?:\\.\\d+)?)/?$"
            },
            series: { urlTemplate: "/Manga/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://ww2.mangafreak.me/Manga/One_Piece", mangaId: "One_Piece" },
            { url: "https://ww3.mangafreak.me/Manga/One_Piece/", mangaId: "One_Piece" },
            { url: "https://mangafreak.me/Manga/One_Piece", mangaId: "One_Piece" },
            { url: "https://ww2.mangafreak.me/Read1_One_Piece_1092", mangaId: "One_Piece" },
            { url: "https://ww2.mangafreak.me/Read1_One_Piece_Strong_World_3.5/", mangaId: "One_Piece_Strong_World" },
            { url: "https://ww2.mangafreak.me/Read1_One_Piece", mangaId: null },
            { url: "https://ww2.mangafreak.me/Manga/One-Piece", mangaId: null },
            { url: "https://ww2.mangafreak.me/", mangaId: null }
        ]
    )

    add(
        "comix",
        {
            match: {
                manga: "^/title/([a-z0-9][a-z0-9-]+)/?$",
                // The numeric chapter id is not captured so group 2 is the chapter NUMBER.
                chapter: "^/title/([a-z0-9][a-z0-9-]+)/\\d+-chapter-(\\d+(?:\\.\\d+)?)/?$"
            },
            series: { urlTemplate: "/title/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://comix.to/title/abc12-some-title", mangaId: "abc12-some-title" },
            { url: "https://www.comix.to/title/abc12-some-title/", mangaId: "abc12-some-title" },
            { url: "https://comix.to/title/abc12-some-title/8123-chapter-45", mangaId: "abc12-some-title" },
            { url: "https://comix.to/title/abc12-some-title/8123-chapter-45.5/", mangaId: "abc12-some-title" },
            { url: "https://comix.to/title/abc12-some-title/chapter-45", mangaId: null },
            { url: "https://comix.to/", mangaId: null }
        ]
    )

    add(
        "nyanukafe",
        {
            match: {
                manga: "^/series/([a-zA-Z0-9]+)/?$",
                chapter: "^/chapter/([a-zA-Z0-9]+)-[a-zA-Z0-9]+/?$"
            },
            series: { urlTemplate: "/series/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://nyanukafe.com/series/a1b2c3", mangaId: "a1b2c3" },
            { url: "https://www.nyanukafe.com/series/a1b2c3/", mangaId: "a1b2c3" },
            { url: "https://nyanukafe.com/chapter/a1b2c3-d4e5f6", mangaId: "a1b2c3" },
            { url: "https://nyanukafe.com/chapter/a1b2c3-d4e5f6/", mangaId: "a1b2c3" },
            { url: "https://nyanukafe.com/chapter/a1b2c3", mangaId: null },
            { url: "https://nyanukafe.com/series/a1-b2", mangaId: null },
            { url: "https://nyanukafe.com/", mangaId: null }
        ]
    )

    add(
        "mangakatana",
        {
            match: {
                manga: "^/manga/([^/]+)$",
                chapter: "^/manga/([^/]+)/c(\\d+(?:\\.\\d+)?)/?$"
            },
            series: { urlTemplate: "/manga/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            {
                url: "https://mangakatana.com/manga/the-archmages-restaurant.27314",
                mangaId: "the-archmages-restaurant.27314"
            },
            {
                url: "https://www.mangakatana.com/manga/the-archmages-restaurant.27314",
                mangaId: "the-archmages-restaurant.27314"
            },
            {
                url: "https://mangakatana.com/manga/the-archmages-restaurant.27314/c142",
                mangaId: "the-archmages-restaurant.27314"
            },
            {
                url: "https://mangakatana.com/manga/the-archmages-restaurant.27314/c142.5/",
                mangaId: "the-archmages-restaurant.27314"
            },
            { url: "https://mangakatana.com/manga/the-archmages-restaurant.27314/", mangaId: null },
            { url: "https://mangakatana.com/manga/x/cabc", mangaId: null },
            { url: "https://mangakatana.com/", mangaId: null }
        ]
    )

    add(
        "flamecomics",
        {
            match: {
                manga: "^/series/(\\d+)/?$",
                chapter: "^/series/(\\d+)/[0-9a-fA-F]{6,}/?$"
            },
            series: { urlTemplate: "/series/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://flamecomics.xyz/series/17", mangaId: "17" },
            { url: "https://flamecomics.xyz/series/17/", mangaId: "17" },
            { url: "https://flamecomics.xyz/series/17/a1b2c3d4e5", mangaId: "17" },
            { url: "https://flamecomics.xyz/series/17/xyz", mangaId: null },
            { url: "https://flamecomics.xyz/series/abc", mangaId: null },
            { url: "https://flamecomics.xyz/", mangaId: null }
        ]
    )

    add(
        "mangak",
        {
            match: {
                manga: `^/(?!(?:${mangakAlt()})/?$)([^/]+)/?$`,
                chapter: `^/(?!(?:${mangakAlt()})/)([^/]+)/chapter-([^/]+)/?$`
            },
            series: { urlTemplate: "/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://mangak.io/some-title", mangaId: "some-title" },
            { url: "https://mangak.io/some-title/", mangaId: "some-title" },
            { url: "https://mangak.io/some-title/chapter-280-237", mangaId: "some-title" },
            { url: "https://mangak.io/some-title/chapter-1/", mangaId: "some-title" },
            { url: "https://mangak.io/some-title/chapter-", mangaId: null },
            { url: "https://mangak.io/some-title/other-1", mangaId: null },
            { url: "https://mangak.io/search", mangaId: null },
            { url: "https://mangak.io/Search/", mangaId: null },
            { url: "https://mangak.io/genre/chapter-1", mangaId: null },
            { url: "https://mangak.io/", mangaId: null }
        ]
    )

    add(
        "roliascan",
        {
            match: {
                manga: "^/manga/([a-z0-9][a-z0-9-]*)/?$",
                chapter: "^/read/([a-z0-9][a-z0-9-]*)/ch([\\d.]+)-\\d+/?$"
            },
            series: { urlTemplate: "/manga/{slug}", titlePattern: OG_TITLE, coverPattern: OG_IMAGE }
        },
        [
            { url: "https://roliascan.com/manga/some-title", mangaId: "some-title" },
            { url: "https://www.roliascan.com/manga/some-title/", mangaId: "some-title" },
            { url: "https://roliascan.com/read/some-title/ch12.5-9981", mangaId: "some-title" },
            { url: "https://roliascan.com/read/some-title/ch12-9981/", mangaId: "some-title" },
            { url: "https://roliascan.com/read/some-title/12-9981", mangaId: null },
            { url: "https://roliascan.com/manga/Some_Title", mangaId: null },
            { url: "https://roliascan.com/", mangaId: null }
        ]
    )

    return entries
}

// ---------------------------------------------------------------------------------------------

export function buildSeedEntries(): SeedEntry[] {
    const byId = new Map<string, SeedEntry>()
    const put = (entry: SeedEntry): void => {
        if (byId.has(entry.profile.id)) throw new Error(`migration seed: duplicate profile id "${entry.profile.id}"`)
        byId.set(entry.profile.id, entry)
    }
    put(madaraEntry(mangareadConfig))
    for (const config of madaraSiteConfigs) put(madaraEntry(config))
    for (const config of mangaStreamSiteConfigs) put(mangaStreamEntry(config))
    for (const config of fanfoxFamilySiteConfigs) put(fanfoxEntry(config))
    for (const config of mangaBuddySiteConfigs) put(mangaBuddyEntry(config))
    for (const entry of bespokeEntries()) put(entry)

    // One profile per shipped source id, emitted in registry order for a stable diff. A bundled
    // adapter with no seed entry (or a seed entry with no adapter) is a build error, never a gap.
    const shipped = sourceAdapters.map(a => a.manifest.id)
    const missing = shipped.filter(id => !byId.has(id))
    if (missing.length > 0) throw new Error(`migration seed: no profile for shipped source(s): ${missing.join(", ")}`)
    const extra = [...byId.keys()].filter(id => !shipped.includes(id))
    if (extra.length > 0) throw new Error(`migration seed: profile(s) for non-shipped source(s): ${extra.join(", ")}`)
    return shipped.map(id => byId.get(id)!)
}

export type MigrationSeed = { seedVersion: 1; profiles: SiteProfile[] }

export function buildSeed(): MigrationSeed {
    return { seedVersion: 1, profiles: buildSeedEntries().map(e => e.profile) }
}
