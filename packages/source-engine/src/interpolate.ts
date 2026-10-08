// ARCHITECTURE TRACK A - experimental.
//
// Closed-namespace template interpolation. This is security control S3 from the council
// review: a profile may ONLY interpolate a fixed, named set of values into its URL/body
// templates, and nothing from the user's library, settings, auth tokens, or install id is
// ever in scope. Every interpolated value is percent-encoded. An unknown {placeholder} is a
// hard error, not a silent empty string, so a profile can never smuggle in a variable we did
// not intend to expose.

import { decodeSlug } from "./slug"

export type InterpolationScope = {
    // The query string the USER typed (search only).
    query?: string
    // The series slug / source manga id of the title being acted on.
    slug?: string
    sourceMangaId?: string
    // Pagination index, when a template drives a paged fetch.
    page?: number | string
}

const ALLOWED_KEYS: ReadonlyArray<keyof InterpolationScope> = ["query", "slug", "sourceMangaId", "page"]

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g

export class InterpolationError extends Error {}

// A slug is lifted from a URL path, so it is already percent-encoded. It is decoded once before the
// uniform encoding below, otherwise a non-ASCII slug is encoded twice and the site answers 404.
const PATH_ENCODED_KEYS: ReadonlyArray<keyof InterpolationScope> = ["slug", "sourceMangaId"]

// Replace {name} tokens in a template with percent-encoded values from the closed scope.
// Throws on any placeholder that is not an allowlisted key or whose value was not supplied.
export function interpolate(template: string, scope: InterpolationScope): string {
    return template.replace(PLACEHOLDER, (_match, rawKey: string) => {
        const key = rawKey as keyof InterpolationScope
        if (!ALLOWED_KEYS.includes(key)) {
            throw new InterpolationError(`Template references an unknown variable "{${rawKey}}"`)
        }
        const value = scope[key]
        if (value === undefined) {
            throw new InterpolationError(`Template needs "{${rawKey}}" but no value was provided`)
        }
        const raw = String(value)
        try {
            return encodeURIComponent(PATH_ENCODED_KEYS.includes(key) ? decodeSlug(raw) : raw)
        } catch {
            throw new InterpolationError(`The value for "{${rawKey}}" is not valid text`)
        }
    })
}
