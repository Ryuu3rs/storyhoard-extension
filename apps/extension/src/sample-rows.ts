import type { LibraryManga } from "./database"

// The lab sample library: manga rows with ids "seed-*" and bundled covers at "/sample-covers/*".
export const SAMPLE_ID_PREFIX = "seed-"
export const SAMPLE_COVER_PREFIX = "/sample-covers/"

export const isSampleRow = (manga: Pick<LibraryManga, "id">): boolean => manga.id.startsWith(SAMPLE_ID_PREFIX)

export const hasSampleCover = (manga: Pick<LibraryManga, "coverUrl">): boolean =>
    manga.coverUrl?.startsWith(SAMPLE_COVER_PREFIX) === true

// A sample is still a sample only while it carries its sample cover. The update cleanup clears the cover of a
// sample the user touched, and from then on it is the user's title, listed and counted like any other.
export const isStillSample = (manga: Pick<LibraryManga, "id" | "coverUrl">): boolean =>
    isSampleRow(manga) && hasSampleCover(manga)

export const isKeptSample = (manga: Pick<LibraryManga, "id" | "coverUrl">): boolean =>
    isSampleRow(manga) && !hasSampleCover(manga)
