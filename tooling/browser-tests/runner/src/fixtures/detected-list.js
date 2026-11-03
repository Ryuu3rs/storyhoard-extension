// A title's page on a made-up reader site, with one chapter row per number and the things a real page
// carries that must not count as chapters of this title: another series' rows and a link to another host.
export function seriesPage(host, latest) {
    const rows = Array.from({ length: latest }, (_, index) => {
        const number = latest - index
        return `<li><a href="/manga/demo-series/chapter-${number}">Chapter ${number}</a></li>`
    }).join("\n")
    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <title>Demo Series</title>
        <meta property="og:title" content="Demo Series" />
    </head>
    <body>
        <h1>Demo Series</h1>
        <ul class="chapters">${rows}</ul>
        <aside>
            <a href="/manga/other-series/chapter-900">Other Series 900</a>
            <a href="/manga/demo-series-side-story/chapter-901">Side Story 901</a>
            <a href="https://elsewhere.example/manga/demo-series/chapter-902">Elsewhere 902</a>
        </aside>
    </body>
</html>`
}
