import { describe, it, expect } from "vitest"
import { encryptBackup, decryptBackup, type BackupEnvelope } from "./backup-crypto"

const SAMPLE = JSON.stringify({ version: 1, manga: [{ id: "a", title: "Berserk" }], progress: { a: 42 } })

describe("backup-crypto", () => {
    it("round-trips an export envelope", async () => {
        const blob = await encryptBackup(SAMPLE, "correct horse battery staple")
        const restored = await decryptBackup(blob, "correct horse battery staple")
        expect(restored).toBe(SAMPLE)
    })

    it("produces a versioned envelope that does not contain the plaintext", async () => {
        const blob = await encryptBackup(SAMPLE, "pw")
        const envelope = JSON.parse(blob) as BackupEnvelope
        expect(envelope.v).toBe(1)
        expect(envelope.kdf).toBe("PBKDF2")
        expect(envelope.salt).toBeTruthy()
        expect(envelope.iv).toBeTruthy()
        expect(blob).not.toContain("Berserk")
    })

    it("uses a fresh random salt and iv per call", async () => {
        const a = JSON.parse(await encryptBackup(SAMPLE, "pw")) as BackupEnvelope
        const b = JSON.parse(await encryptBackup(SAMPLE, "pw")) as BackupEnvelope
        expect(a.salt).not.toBe(b.salt)
        expect(a.iv).not.toBe(b.iv)
        expect(a.ct).not.toBe(b.ct)
    })

    it("rejects a wrong passphrase", async () => {
        const blob = await encryptBackup(SAMPLE, "right")
        await expect(decryptBackup(blob, "wrong")).rejects.toThrow(/wrong passphrase/i)
    })

    it("rejects a tampered ciphertext (GCM tag mismatch)", async () => {
        const envelope = JSON.parse(await encryptBackup(SAMPLE, "pw")) as BackupEnvelope
        const bytes = atob(envelope.ct)
        const flipped = bytes.slice(0, -1) + String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 0x01)
        const tampered = JSON.stringify({ ...envelope, ct: btoa(flipped) })
        await expect(decryptBackup(tampered, "pw")).rejects.toThrow(/could not decrypt/i)
    })

    it("rejects a non-envelope blob and an unsupported version", async () => {
        await expect(decryptBackup("not json", "pw")).rejects.toThrow(/not a valid/i)
        const bogus = JSON.stringify({
            v: 999,
            kdf: "PBKDF2",
            salt: "",
            iv: "",
            ct: "",
            hash: "SHA-256",
            iterations: 1
        })
        await expect(decryptBackup(bogus, "pw")).rejects.toThrow(/unsupported or corrupted/i)
    })

    it("requires a passphrase to encrypt", async () => {
        await expect(encryptBackup(SAMPLE, "")).rejects.toThrow(/passphrase is required/i)
    })
})

describe("backup-crypto - bughunt regressions", () => {
    it("rejects a base64-corrupted envelope with a clean error, not a raw DOMException", async () => {
        const corrupt = JSON.stringify({
            v: 1,
            kdf: "PBKDF2",
            hash: "SHA-256",
            iterations: 210000,
            salt: "!!!",
            iv: "AAAAAAAAAAAAAAAA",
            ct: "AAAA"
        })
        await expect(decryptBackup(corrupt, "pw")).rejects.toThrow(/corrupted backup envelope/)
    })

    it("rejects an absurd iteration count instead of pinning the CPU", async () => {
        const blob = await encryptBackup(SAMPLE, "pw")
        const env = JSON.parse(blob) as BackupEnvelope
        env.iterations = 2_000_000_000
        await expect(decryptBackup(JSON.stringify(env), "pw")).rejects.toThrow(/corrupted backup envelope/)
    })
})

describe("backup-crypto passphrase whitespace", () => {
    it("opens a backup exported with a trimmed passphrase when the import passphrase has stray spaces", async () => {
        const blob = await encryptBackup(SAMPLE, "pw")
        expect(await decryptBackup(blob, "  pw \n")).toBe(SAMPLE)
    })

    it("still opens a backup whose passphrase really had surrounding spaces", async () => {
        const blob = await encryptBackup(SAMPLE, " pw ")
        expect(await decryptBackup(blob, " pw ")).toBe(SAMPLE)
    })
})
