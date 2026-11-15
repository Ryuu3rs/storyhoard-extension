// Client-side encryption for export envelopes. AES-GCM with a key derived from the
// user's passphrase via PBKDF2, so a backup can travel over any transport (local file,
// the user's own Gist) without the transport ever seeing plaintext. Pure WebCrypto, no
// network, no browser.* - works identically in the extension and under vitest (Node 22).

const ENVELOPE_VERSION = 1
const KDF = "PBKDF2"
const HASH = "SHA-256"
const PBKDF2_ITERATIONS = 210000
// Ceiling on the iteration count read from an untrusted envelope, so a hostile backup
// file can't set iterations to billions and pin the CPU when the user tries to open it.
const MAX_ITERATIONS = 10_000_000
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BITS = 256

// Versioned, self-describing envelope so a future KDF/param change stays decryptable.
export type BackupEnvelope = {
    v: number
    kdf: typeof KDF
    hash: typeof HASH
    iterations: number
    salt: string
    iv: string
    ct: string
}

function toBase64(bytes: Uint8Array): string {
    let binary = ""
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
}

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), KDF, false, [
        "deriveKey"
    ])
    return crypto.subtle.deriveKey(
        { name: KDF, hash: HASH, salt, iterations },
        baseKey,
        { name: "AES-GCM", length: KEY_BITS },
        false,
        ["encrypt", "decrypt"]
    )
}

// Encrypts a JSON export string, returning the serialized envelope (JSON text).
export async function encryptBackup(json: string, passphrase: string): Promise<string> {
    if (!passphrase) throw new Error("A passphrase is required to encrypt a backup.")
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS)
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json))
    const envelope: BackupEnvelope = {
        v: ENVELOPE_VERSION,
        kdf: KDF,
        hash: HASH,
        iterations: PBKDF2_ITERATIONS,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ct: toBase64(new Uint8Array(ciphertext))
    }
    return JSON.stringify(envelope)
}

// Decrypts a serialized envelope back to the original JSON string. Rejects cleanly on a
// wrong passphrase or a tampered ciphertext/tag (both surface as an AES-GCM auth failure).
export async function decryptBackup(blob: string, passphrase: string): Promise<string> {
    let envelope: BackupEnvelope
    try {
        envelope = JSON.parse(blob) as BackupEnvelope
    } catch {
        throw new Error("This backup is not a valid StoryHoard encrypted envelope.")
    }
    if (
        !envelope ||
        envelope.v !== ENVELOPE_VERSION ||
        envelope.kdf !== KDF ||
        typeof envelope.salt !== "string" ||
        typeof envelope.iv !== "string" ||
        typeof envelope.ct !== "string" ||
        !Number.isInteger(envelope.iterations) ||
        envelope.iterations < 1 ||
        envelope.iterations > MAX_ITERATIONS
    ) {
        throw new Error("Unsupported or corrupted backup envelope.")
    }
    // Decode inside the guard: a truncated/garbled base64 field would otherwise throw a
    // raw DOMException past the clean errors this function promises.
    let salt: Uint8Array<ArrayBuffer>
    let iv: Uint8Array<ArrayBuffer>
    let ct: Uint8Array<ArrayBuffer>
    try {
        salt = fromBase64(envelope.salt)
        iv = fromBase64(envelope.iv)
        ct = fromBase64(envelope.ct)
    } catch {
        throw new Error("Unsupported or corrupted backup envelope.")
    }
    // Export trims the passphrase, so a pasted one with stray whitespace is tried trimmed first.
    // The raw form is the fallback for an envelope encrypted with untrimmed input.
    const candidates = passphrase.trim() === passphrase ? [passphrase] : [passphrase.trim(), passphrase]
    for (const candidate of candidates) {
        const key = await deriveKey(candidate, salt, envelope.iterations)
        try {
            const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct)
            return new TextDecoder().decode(plaintext)
        } catch {
            // Try the next candidate; the error below covers all of them failing.
        }
    }
    throw new Error("Could not decrypt backup: wrong passphrase or the file was modified.")
}
