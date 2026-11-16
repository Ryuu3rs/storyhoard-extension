// Cover art is a still image. An animated one is a site's loading animation served in place of the
// real cover (one site answers every cover address with the same 144-frame GIF), so it is never kept.
// Reads only the container structure: GIF frame count, the PNG animation chunk, the WebP animation flag.

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))

// Skips a run of GIF data sub-blocks (length byte, then that many bytes, until a zero length).
function skipSubBlocks(bytes: Uint8Array, at: number): number {
    let pos = at
    while (pos < bytes.length) {
        const size = bytes[pos]!
        pos += 1
        if (size === 0) return pos
        pos += size
    }
    return bytes.length
}

function gifFrameCount(bytes: Uint8Array, stopAt: number): number {
    if (bytes.length < 13) return 0
    let pos = 13
    const packed = bytes[10]!
    if (packed & 0x80) pos += 3 * (1 << ((packed & 0x07) + 1))
    let frames = 0
    while (pos < bytes.length) {
        const block = bytes[pos]!
        if (block === 0x2c) {
            frames += 1
            if (frames >= stopAt) return frames
            if (pos + 10 > bytes.length) return frames
            const local = bytes[pos + 9]!
            pos += 10
            if (local & 0x80) pos += 3 * (1 << ((local & 0x07) + 1))
            pos = skipSubBlocks(bytes, pos + 1)
        } else if (block === 0x21) {
            pos = skipSubBlocks(bytes, pos + 2)
        } else {
            return frames
        }
    }
    return frames
}

function pngIsAnimated(bytes: Uint8Array): boolean {
    let pos = 8
    while (pos + 8 <= bytes.length) {
        const length = ((bytes[pos]! << 24) | (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!) >>> 0
        const type = ascii(bytes, pos + 4, 4)
        if (type === "acTL") return true
        if (type === "IDAT" || type === "IEND") return false
        pos += 12 + length
    }
    return false
}

function webpIsAnimated(bytes: Uint8Array): boolean {
    let pos = 12
    while (pos + 8 <= bytes.length) {
        const type = ascii(bytes, pos, 4)
        const length =
            (bytes[pos + 4]! | (bytes[pos + 5]! << 8) | (bytes[pos + 6]! << 16) | (bytes[pos + 7]! << 24)) >>> 0
        if (type === "ANIM" || type === "ANMF") return true
        if (type === "VP8X" && pos + 8 < bytes.length && (bytes[pos + 8]! & 0x02) !== 0) return true
        pos += 8 + length + (length % 2)
    }
    return false
}

export function isAnimatedImage(bytes: Uint8Array): boolean {
    if (ascii(bytes, 0, 4) === "GIF8") return gifFrameCount(bytes, 2) > 1
    if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return pngIsAnimated(bytes)
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpIsAnimated(bytes)
    return false
}

// A PNG or WebP says it is animated near its start, so only a GIF, which must be walked frame by
// frame, is read in full.
export async function isAnimatedBlob(blob: Blob): Promise<boolean> {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
    const isGif = ascii(head, 0, 4) === "GIF8"
    const bytes = isGif ? await blob.arrayBuffer() : await blob.slice(0, 64 * 1024).arrayBuffer()
    return isAnimatedImage(new Uint8Array(bytes))
}
