// Registry of supported "import from another reader" formats. The import UI renders one dropdown
// entry per format here, and the import handler looks the chosen id up to get its parser. Adding a
// new reader = add an entry; nothing else in the UI/handler changes.

import { inflateCapped } from "./inflate"
import { parseMangayomiBackup } from "./mangayomi"
import { parseMihonBackup } from "./mihon"
import type { ImportedManga } from "./types"
import { unzipFirst } from "./zip"

export type { ImportedManga }

export type ImportFormatId = "mihon" | "mangayomi"

export type ImportFormat = {
    id: ImportFormatId
    // Shown in the dropdown.
    label: string
    // File-picker accept hint.
    accept: string
    // Parse a raw uploaded file (handles its own decompression) into normalized manga.
    parse: (file: Uint8Array) => Promise<ImportedManga[]>
}

const decoder = new TextDecoder()
const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b
const isZip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x50 && b[1] === 0x4b

// gzip-decompress when the file has the gzip magic; a `.tachibk` is gzipped protobuf, but some
// exports/tools hand over raw protobuf, so fall through to the bytes as-is.
async function maybeGunzip(bytes: Uint8Array): Promise<Uint8Array> {
    if (isGzip(bytes)) return inflateCapped(bytes, "gzip")
    return bytes
}

export const IMPORT_FORMATS: readonly ImportFormat[] = [
    {
        id: "mihon",
        label: "Mihon / Tachiyomi (.tachibk)",
        accept: ".tachibk,.gz,.proto.gz",
        parse: async file => parseMihonBackup(await maybeGunzip(file))
    },
    {
        id: "mangayomi",
        label: "Mangayomi (.backup)",
        accept: ".backup,.zip,.db",
        parse: async file => {
            // A Mangayomi .backup is a zip holding a single <name>.backup.db JSON file; accept a
            // raw JSON export too.
            const text = isZip(file)
                ? decoder.decode(await unzipFirst(file, n => n.endsWith(".db") || n.endsWith(".json")))
                : decoder.decode(file)
            return parseMangayomiBackup(text)
        }
    }
]

export function getImportFormat(id: string): ImportFormat | undefined {
    return IMPORT_FORMATS.find(f => f.id === id)
}
