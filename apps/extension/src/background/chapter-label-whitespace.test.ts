import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const source = readFileSync(fileURLToPath(new URL("./inject-chapter-prompt.ts", import.meta.url)), "utf8")

describe("currentChapterLabel whitespace collapse", () => {
    it("collapses runs of WHITESPACE, not the literal letter s", () => {
        const start = source.indexOf("function currentChapterLabel")
        const body = source.slice(start, source.indexOf("function trackChapter", start))
        // The label is read from the page and sent to the background as the chapter label, where a
        // text-numbered source parses its number from it. It must collapse whitespace (\s), never the
        // letter "s": /s+/g turns "Boss Class" into "Bo Cla " and mangles every label with an s.
        expect(body).not.toMatch(/replace\(\/s\+\/g/)
        expect(body).toMatch(/replace\(\/\\s\+\/g/)
    })
})
