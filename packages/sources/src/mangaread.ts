import { createMadaraAdapter, type MadaraConfig } from "./madara"

// MangaRead is a standard Madara site. All behaviour lives in the shared factory;
// this file is just its configuration row.
export const mangareadConfig: MadaraConfig = {
    id: "mangaread",
    name: "MangaRead",
    origin: "https://www.mangaread.org",
    domains: ["mangaread.org", "www.mangaread.org"],
    // mangaread.org puts the real image URL in src and an anti-scraping decoy in data-src.
    // Matches legacy Madara default: img_src:"src", secondary_img_src:"data-src".
    preferSrcAttribute: true
}

export const mangareadAdapter = createMadaraAdapter(mangareadConfig)
