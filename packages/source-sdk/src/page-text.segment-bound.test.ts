import { afterEach, describe, expect, it } from "vitest"
import { MAX_PAGE_TITLE_LENGTH, sanitizePageText } from "./page-text"

// Only the first maxLength graphemes are kept, so a multi-megabyte title is not segmented past them.
describe("sanitizePageText segmenting", () => {
    const Real = Intl.Segmenter
    afterEach(() => {
        ;(Intl as { Segmenter: typeof Intl.Segmenter }).Segmenter = Real
    })

    it("reads no more graphemes than it can keep", () => {
        let pulled = 0
        class Counting extends Real {
            override segment(input: string) {
                const inner = super.segment(input)
                return {
                    [Symbol.iterator]: function* () {
                        for (const s of inner) {
                            pulled++
                            yield s
                        }
                    }
                } as unknown as Intl.Segments
            }
        }
        ;(Intl as { Segmenter: typeof Intl.Segmenter }).Segmenter = Counting
        const out = sanitizePageText("x".repeat(1_000_000))
        expect(out).toBe("x".repeat(MAX_PAGE_TITLE_LENGTH))
        expect(pulled).toBeLessThanOrEqual(MAX_PAGE_TITLE_LENGTH + 1)
    })
})
