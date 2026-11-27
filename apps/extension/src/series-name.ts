// The series name a chapter page shows for itself, read from its own og:title, document title or heading.
// Those name the chapter and the site as well ("Lantern Keeper Chapter 3 - Reader Demo"), so the chapter
// label and the site's name are taken off. A name is only kept when it shares a word with the series slug
// in the address, which is what stops a site-wide title ("Read comics online") or a challenge page ("Just a
// moment...") being taken for the series.

import { stripSlugHash } from "@amr/source-engine"
import { sanitizePageText } from "./page-text"

export type PageNameSignals = {
    ogTitle?: string | undefined
    docTitle?: string | undefined
    heading?: string | undefined
    siteName?: string | undefined
}

const MAX_SERIES_NAME_LENGTH = 120

// The long dashes, middle dot, bullet and guillemet a page title may use between its parts, by code point.
const DASHES = String.fromCharCode(0x2013, 0x2014)
const MARKS = String.fromCharCode(0x00b7, 0x2022, 0x00bb)
const TRAILING_PUNCTUATION = new RegExp(String.raw`[\s,:;([/${DASHES}-]+$`)

// A separator between the parts of a page title: a dash, colon, bar or one of the marks above with spaces
// on both sides, or a bare bar. "Re:Monster" and "Spider-Man" are not split.
const SEPARATOR = new RegExp(String.raw`\s+[-:|${DASHES}${MARKS}]{1,2}\s+|\s*\|\s*`)

// Where a chapter label starts: "Chapter 12", "Ch. 3", "Episode 4", "Ep 5", "Vol. 2", "#12", "第12话", "제12화".
const CHAPTER_LABEL =
    /(?:^|[\s([,])(?:chapters?|chap|ch|episodes?|eps?|vol(?:ume)?|issue|part)\.?\s*#?\s*\d|(?:^|\s)#\d|[第제]\s*\d/i

// Words too common to show a page title names this series.
const WEAK_WORDS = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "read",
    "online",
    "free",
    "chapter",
    "episode",
    "manga",
    "manhwa",
    "manhua",
    "comic",
    "comics",
    "webtoon"
])

// A whole CJK chapter label: "第01話", "第12话", "第3章", "第100集", "제12화", with ASCII or full-width digits.
// Season and volume labels ("第2季", "第3卷") are not chapter labels.
const CJK_CHAPTER_LABEL = /[第제]\s*[0-9０-９]+(?:[.．][0-9０-９]+)?\s*[话話章回集화]/
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const CJK_ONLY = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}\p{P}\sー～]+$/u
const LATIN_WORD = /^[\p{Script=Latin}\p{N}]+$/u

function decodeSlug(slug: string): string {
    try {
        return decodeURIComponent(slug)
    } catch {
        return slug
    }
}

const wordsOf = (value: string): string[] =>
    value
        .toLocaleLowerCase("en")
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)

const keyOf = (value: string): string => wordsOf(value).join("")

function withoutChapter(part: string): string {
    const at = [part.search(CHAPTER_LABEL), part.search(CJK_CHAPTER_LABEL)].filter(i => i >= 0)
    return (at.length === 0 ? part : part.slice(0, Math.min(...at)))
        .replace(TRAILING_PUNCTUATION, "")
        .replace(/^read\s+/i, "")
        .replace(/\s+(?:online(?:\s+free)?|for\s+free)$/i, "")
        .trim()
}

// The keys a part naming the site itself has: og:site_name, and the host with and without its suffix.
function siteKeys(host: string, siteName: string | undefined): Set<string> {
    const bare = host.toLowerCase().replace(/^www\./, "")
    const keys = new Set([keyOf(bare), keyOf(bare.replace(/\.[^.]+$/, ""))])
    if (siteName) keys.add(keyOf(siteName))
    keys.delete("")
    return keys
}

// A romanized slug cannot share a word with a name written in CJK, so a CJK name is taken instead when it
// is the text right in front of a whole CJK chapter label, in its own part ("<name>/第01話") or as the part
// before one ("<name> - 第01話 - <site>"). A site-wide title or a challenge page carries no chapter label.
function cjkNameBeforeLabel(name: string, part: string, next: string | undefined): boolean {
    if (!CJK_LETTER.test(name) || !CJK_ONLY.test(name)) return false
    return part.search(CJK_CHAPTER_LABEL) > 0 || next?.trim().search(CJK_CHAPTER_LABEL) === 0
}

function slugWords(slug: string): string[] {
    return wordsOf(stripSlugHash(decodeSlug(slug))).filter(
        word => word.length >= 3 && /\p{L}/u.test(word) && !WEAK_WORDS.has(word)
    )
}

// The series name in one page title, or undefined when no part of it names this series.
export function seriesNameFromTitle(
    raw: string | undefined,
    context: { slug: string; host: string; siteName?: string | undefined }
): string | undefined {
    const text = sanitizePageText(raw ?? "", 400)
    if (!text) return undefined
    const site = siteKeys(context.host, context.siteName)
    const wanted = slugWords(context.slug)
    const romanized = wanted.length > 0 && wanted.every(word => LATIN_WORD.test(word))
    const parts = text.split(SEPARATOR)
    for (const [index, part] of parts.entries()) {
        const name = withoutChapter(part)
        const key = keyOf(name)
        if (!key || site.has(key)) continue
        const words = new Set(wordsOf(name))
        const shared = wanted.length === 0 || wanted.some(word => words.has(word))
        if (!shared && !(romanized && cjkNameBeforeLabel(name, part, parts[index + 1]))) continue
        const clean = sanitizePageText(name, MAX_SERIES_NAME_LENGTH)
        if (clean) return clean
    }
    return undefined
}

// The series name the page shows: og:title first, then the document title, then the main heading.
export function seriesNameFromPage(
    signals: PageNameSignals,
    context: { slug: string; host: string }
): string | undefined {
    for (const raw of [signals.ogTitle, signals.docTitle, signals.heading]) {
        const name = seriesNameFromTitle(raw, { ...context, siteName: signals.siteName })
        if (name) return name
    }
    return undefined
}
