// Real reader backups are a few MB at most. The cap stops a tiny crafted file from inflating
// into gigabytes and taking the extension's memory with it.
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024

export async function inflateCapped(
    data: Uint8Array,
    format: CompressionFormat,
    maxBytes: number = MAX_INFLATED_BYTES
): Promise<Uint8Array> {
    const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format)).getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new Error(`Backup is too large to open (over ${Math.round(maxBytes / (1024 * 1024))} MB unpacked).`)
        }
        chunks.push(value)
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out
}
