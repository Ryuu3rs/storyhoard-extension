// Minimal, read-only ZIP reader - enough to pull one JSON entry out of a Mangayomi `.backup`
// (a zip containing a single `.backup.db` JSON file). Central-directory based so it is robust to
// data descriptors. Supports stored (0) and deflate (8) entries; rejects encrypted zips with a
// clear message (Mangayomi's optional password protection is not supported yet). Dependency-free.

import { inflateCapped } from "./inflate"

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

function findEocd(view: DataView, len: number): number {
    // Scan backwards from the end for the EOCD signature (comment can be up to 65535 bytes).
    const min = Math.max(0, len - 22 - 0xffff)
    for (let i = len - 22; i >= min; i--) {
        if (view.getUint32(i, true) === EOCD_SIG) return i
    }
    return -1
}

// Extract the first central-directory entry whose name satisfies `match` (default: any).
export async function unzipFirst(
    bytes: Uint8Array,
    match: (name: string) => boolean = () => true
): Promise<Uint8Array> {
    try {
        return await readFirstEntry(bytes, match)
    } catch (error) {
        // A DataView read past the end of a truncated or crafted file throws a bare RangeError.
        if (error instanceof RangeError) throw new Error("Corrupt zip file.")
        throw error
    }
}

async function readFirstEntry(bytes: Uint8Array, match: (name: string) => boolean): Promise<Uint8Array> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const eocd = findEocd(view, bytes.length)
    if (eocd < 0) throw new Error("Not a valid zip file.")
    const count = view.getUint16(eocd + 10, true)
    let p = view.getUint32(eocd + 16, true) // central directory offset
    const decoder = new TextDecoder()

    for (let i = 0; i < count; i++) {
        if (view.getUint32(p, true) !== CEN_SIG) throw new Error("Corrupt zip central directory.")
        const flag = view.getUint16(p + 8, true)
        const method = view.getUint16(p + 10, true)
        const compSize = view.getUint32(p + 20, true)
        const nameLen = view.getUint16(p + 28, true)
        const extraLen = view.getUint16(p + 30, true)
        const commentLen = view.getUint16(p + 32, true)
        const localOffset = view.getUint32(p + 42, true)
        const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen))
        p += 46 + nameLen + extraLen + commentLen

        if (!match(name)) continue
        if (flag & 0x0001)
            throw new Error("This backup is encrypted. Turn off backup encryption in the app and export again.")

        // Local header: sizes here can be zeroed (data descriptor), so use the central-dir size
        // and only read the local name/extra lengths to locate the data.
        if (view.getUint32(localOffset, true) !== LOC_SIG) throw new Error("Corrupt zip entry.")
        const locNameLen = view.getUint16(localOffset + 26, true)
        const locExtraLen = view.getUint16(localOffset + 28, true)
        const dataStart = localOffset + 30 + locNameLen + locExtraLen
        if (dataStart + compSize > bytes.length) throw new Error("Corrupt zip entry.")
        const data = bytes.subarray(dataStart, dataStart + compSize)
        if (method === 0) return data
        if (method === 8) return inflateCapped(data, "deflate-raw")
        throw new Error(`Unsupported zip compression method ${method}.`)
    }
    throw new Error("No matching entry found in the backup zip.")
}
