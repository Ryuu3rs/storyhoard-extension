import { describe, expect, it } from "vitest"
import { md5 } from "./md5"

describe("md5", () => {
    it("matches the RFC 1321 test vectors", () => {
        expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e")
        expect(md5("a")).toBe("0cc175b9c0f1b6a831c399e269772661")
        expect(md5("abc")).toBe("900150983cd24fb0d6963f7d28e17f72")
        expect(md5("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0")
        expect(md5("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b")
        expect(md5("The quick brown fox jumps over the lazy dog")).toBe("9e107d9d372bb6826bd81d3542a419d6")
    })

    it("spans multiple 64-byte blocks correctly", () => {
        expect(md5("a".repeat(80))).toBe("b15af9cdabbaea0516866a33d8fd0f98")
    })

    it("handles multibyte UTF-8", () => {
        expect(md5("é")).toBe("66ddcd97cfdeabb2f6fb8a999b4bc76f")
        expect(md5("재벌의 품격")).toBe("842604eeba0596046283f9248b985ca5")
    })
})
