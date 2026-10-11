import { describe, expect, it } from "vitest"
import { holdPromotion, promotionSettled } from "./promotion-lock"

describe("promotion lock", () => {
    it("makes a recorder wait until the move for that site has finished", async () => {
        const order: string[] = []
        let finish: () => void = () => undefined
        const moving = holdPromotion("detected:a.example", async () => {
            await new Promise<void>(resolve => (finish = resolve))
            order.push("moved")
        })
        const waiting = promotionSettled("detected:a.example").then(() => order.push("recorder"))

        await Promise.resolve()
        expect(order).toEqual([])
        finish()
        await Promise.all([moving, waiting])
        expect(order).toEqual(["moved", "recorder"])
    })

    it("does not hold up another site, and releases once idle", async () => {
        let finish: () => void = () => undefined
        const moving = holdPromotion("detected:a.example", () => new Promise<void>(resolve => (finish = resolve)))
        await promotionSettled("detected:b.example")
        finish()
        await moving
        await promotionSettled("detected:a.example")
    })

    it("keeps the lock free after a move that failed", async () => {
        await expect(
            holdPromotion("detected:c.example", async () => {
                throw new Error("boom")
            })
        ).rejects.toThrow("boom")
        await promotionSettled("detected:c.example")
        await expect(holdPromotion("detected:c.example", async () => 7)).resolves.toBe(7)
    })
})
