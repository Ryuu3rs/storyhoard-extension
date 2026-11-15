import { describe, expect, it } from "vitest"
import { summarizeChapters } from "./chapter-summary"

describe("summarizeChapters", () => {
    it("counts each chapter once across uploads and reads the newest number and date", () => {
        expect(
            summarizeChapters([
                { sortKey: 1, publishedAt: 1_000 },
                { sortKey: 2, publishedAt: 2_000 },
                { sortKey: 2, publishedAt: 2_500 },
                { sortKey: 2.5 }
            ])
        ).toEqual({ count: 3, latest: 2.5, latestAt: 2_500 })
    })

    it("counts an unnumbered extra without letting it win latest", () => {
        expect(summarizeChapters([{ sortKey: 10 }, { sortKey: Number.POSITIVE_INFINITY }])).toEqual({
            count: 2,
            latest: 10
        })
    })

    it("reports an empty list as zero chapters", () => {
        expect(summarizeChapters([])).toEqual({ count: 0 })
    })
})
