import { describe, expect, it } from "vitest"
import { isAnimatedBlob, isAnimatedImage } from "./animated-image"

// Tiny hand-built images: a GIF frame is an image descriptor, a global colour table and one data
// sub-block; an animated GIF adds a graphic-control extension and a second frame.
const GIF_HEADER = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]
const GIF_FRAME = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0]
const GIF_CONTROL = [0x21, 0xf9, 4, 0, 10, 0, 0, 0]

const stillGif = () => new Uint8Array([...GIF_HEADER, ...GIF_FRAME, 0x3b])
const animatedGif = () =>
    new Uint8Array([...GIF_HEADER, ...GIF_CONTROL, ...GIF_FRAME, ...GIF_CONTROL, ...GIF_FRAME, 0x3b])

function pngChunk(type: string, data: number[] = []): number[] {
    const length = [0, 0, 0, data.length]
    return [...length, ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR = pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
const stillPng = () => new Uint8Array([...PNG_SIGNATURE, ...IHDR, ...pngChunk("IDAT", [0]), ...pngChunk("IEND")])
const animatedPng = () =>
    new Uint8Array([
        ...PNG_SIGNATURE,
        ...IHDR,
        ...pngChunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]),
        ...pngChunk("IDAT", [0]),
        ...pngChunk("IEND")
    ])

function webp(flags: number): Uint8Array {
    const vp8x = [0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    return new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...vp8x])
}

describe("isAnimatedImage", () => {
    it("tells an animated GIF from a still one", () => {
        expect(isAnimatedImage(animatedGif())).toBe(true)
        expect(isAnimatedImage(stillGif())).toBe(false)
    })

    it("finds the animation chunk of an animated PNG", () => {
        expect(isAnimatedImage(animatedPng())).toBe(true)
        expect(isAnimatedImage(stillPng())).toBe(false)
    })

    it("reads the animation flag of a WebP", () => {
        expect(isAnimatedImage(webp(0x02))).toBe(true)
        expect(isAnimatedImage(webp(0x10))).toBe(false)
    })

    it("calls a JPEG, an empty file and cut-off or garbage bytes still", () => {
        expect(isAnimatedImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe(false)
        expect(isAnimatedImage(new Uint8Array([]))).toBe(false)
        expect(isAnimatedImage(animatedGif().slice(0, 30))).toBe(false)
        expect(isAnimatedImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 255, 255, 255]))).toBe(false)
    })

    it("reads blobs the same way", async () => {
        expect(await isAnimatedBlob(new Blob([animatedGif()], { type: "image/gif" }))).toBe(true)
        expect(await isAnimatedBlob(new Blob([animatedPng()], { type: "image/png" }))).toBe(true)
        expect(await isAnimatedBlob(new Blob([stillPng()], { type: "image/png" }))).toBe(false)
    })
})
