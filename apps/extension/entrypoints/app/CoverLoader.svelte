<script lang="ts">
    // Shown on a cover tile while a cover refresh is looking for its image: a ring with one wave
    // packet travelling round it. Reduced motion gets the same ring, still.
    const POINTS = 120
    const RADIUS = 26
    const AMPLITUDE = 7
    const RIPPLES = 9
    const PACKET_WIDTH = 0.7
    const SPEED = 1.6

    function ring(time: number): string {
        const head = (time * SPEED) % (2 * Math.PI)
        let d = ""
        for (let i = 0; i <= POINTS; i += 1) {
            const angle = (i / POINTS) * 2 * Math.PI
            let gap = Math.abs(angle - head)
            gap = Math.min(gap, 2 * Math.PI - gap)
            const bump = Math.exp(-((gap / PACKET_WIDTH) ** 2))
            const r = RADIUS + AMPLITUDE * bump * Math.sin(RIPPLES * angle - time * 6)
            const x = 50 + r * Math.cos(angle)
            const y = 50 + r * Math.sin(angle)
            d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`
        }
        return `${d}Z`
    }

    let path = $state(ring(0.6))

    $effect(() => {
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
        let frame = 0
        const start = performance.now()
        const tick = (now: number) => {
            path = ring((now - start) / 1000)
            frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(frame)
    })
</script>

<svg class="cover-loader" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r={RADIUS} class="track" />
    <path d={path} class="wave" />
</svg>

<style>
    .cover-loader {
        width: min(64%, 96px);
        aspect-ratio: 1;
        overflow: visible;
    }
    .track {
        fill: none;
        stroke: hsl(var(--ph-hue, 265) 45% 75% / 0.18);
        stroke-width: 2;
    }
    .wave {
        fill: none;
        stroke: hsl(var(--ph-hue, 265) 70% 82%);
        stroke-width: 2.4;
        stroke-linejoin: round;
        filter: drop-shadow(0 0 3px hsl(var(--ph-hue, 265) 80% 70% / 0.55));
    }
</style>
