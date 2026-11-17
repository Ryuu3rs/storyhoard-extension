import type { SampleEntry } from "../database"

// The "Load samples" library, for the local testing build only: the shipped build has no button or
// handler for it, so none of this reaches the store bundle.
export function sampleEntries(now: number): SampleEntry[] {
    return [
        {
            manga: {
                id: "seed-md-001",
                title: "Buried Injustice",
                normalizedTitle: "buried injustice",
                coverUrl: "/sample-covers/buried-injustice.jpg",
                authors: [],
                status: "ongoing",
                // Real AniList id so the sample library actually drives the Discover tab
                // (suggestions seed from library titles that carry an anilistId).
                anilistId: 194902,
                sourceId: "mangadex",
                sourceUrl: "https://mangadex.org/chapter/3dff8b5f-844e-4964-abd7-641c34f1f091",
                sourceMangaId: "62994137-014f-4499-b88a-c219b115fd64",
                mangaUrl: "https://mangadex.org/title/62994137-014f-4499-b88a-c219b115fd64",
                addedAt: now - 86400000 * 7,
                updatedAt: now - 3600000 * 2,
                latestChapterId: "seed-md-001-ch"
            },
            chapterUrl: "https://mangadex.org/chapter/3dff8b5f-844e-4964-abd7-641c34f1f091",
            sourceId: "mangadex",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-mr-001",
                title: "Entomologist In Sichuan Tang Clan",
                normalizedTitle: "entomologist in sichuan tang clan",
                coverUrl: "/sample-covers/entomologist.jpg",
                authors: [],
                status: "ongoing",
                anilistId: 185452,
                sourceId: "mangaread",
                sourceUrl: "https://www.mangaread.org/manga/entomologist-in-sichuan-tang-clan/chapter-79/?style=list",
                sourceMangaId: "entomologist-in-sichuan-tang-clan",
                mangaUrl: "https://www.mangaread.org/manga/entomologist-in-sichuan-tang-clan/",
                addedAt: now - 86400000 * 5,
                updatedAt: now - 3600000 * 5,
                latestChapterId: "seed-mr-001-ch"
            },
            chapterUrl: "https://www.mangaread.org/manga/entomologist-in-sichuan-tang-clan/chapter-79/?style=list",
            sourceId: "mangaread",
            chapterTitle: "Chapter 79",
            sortKey: 79
        },
        {
            manga: {
                id: "seed-mr-002",
                title: "Legendary Youngest Son Of The Marquis House",
                normalizedTitle: "legendary youngest son of the marquis house",
                coverUrl: "/sample-covers/legendary-marquis.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "mangaread",
                sourceUrl:
                    "https://www.mangaread.org/manga/legendary-youngest-son-of-the-marquis-house/chapter-161/?style=list",
                sourceMangaId: "legendary-youngest-son-of-the-marquis-house",
                mangaUrl: "https://www.mangaread.org/manga/legendary-youngest-son-of-the-marquis-house/",
                addedAt: now - 86400000 * 3,
                updatedAt: now - 3600000 * 8,
                latestChapterId: "seed-mr-002-ch"
            },
            chapterUrl:
                "https://www.mangaread.org/manga/legendary-youngest-son-of-the-marquis-house/chapter-161/?style=list",
            sourceId: "mangaread",
            chapterTitle: "Chapter 161",
            sortKey: 161
        },
        {
            manga: {
                id: "seed-mgk-001",
                title: "Barbarian's Adventure In A Fantasy World",
                normalizedTitle: "barbarian's adventure in a fantasy world",
                coverUrl: "/sample-covers/barbarian-fantasy.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "mgeko",
                sourceUrl: "https://www.mgeko.cc/reader/en/barbarians-adventure-in-a-fantasy-world-chapter-52-eng-li/",
                sourceMangaId: "barbarians-adventure-in-a-fantasy-world",
                mangaUrl: "https://www.mgeko.cc/comic/barbarians-adventure-in-a-fantasy-world/",
                addedAt: now - 86400000 * 2,
                updatedAt: now - 3600000 * 12,
                latestChapterId: "seed-mgk-001-ch"
            },
            chapterUrl: "https://www.mgeko.cc/reader/en/barbarians-adventure-in-a-fantasy-world-chapter-52-eng-li/",
            sourceId: "mgeko",
            chapterTitle: "Chapter 52",
            sortKey: 52
        },
        {
            manga: {
                id: "seed-wc-001",
                title: "Jujutsu Kaisen",
                normalizedTitle: "jujutsu kaisen",
                coverUrl: "/sample-covers/jujutsu-kaisen.jpg",
                authors: ["Gege Akutami"],
                status: "ongoing",
                anilistId: 101517,
                sourceId: "weebcentral",
                sourceUrl: "https://weebcentral.com/chapters/01KWX62ZXF6VQDFEM1ADY98TFD/",
                sourceMangaId: "01KWX62ZXF6VQDFEM1ADY98TFD",
                mangaUrl: "https://weebcentral.com/chapters/01KWX62ZXF6VQDFEM1ADY98TFD/",
                addedAt: now - 86400000 * 10,
                updatedAt: now - 3600000 * 1,
                latestChapterId: "seed-wc-001-ch"
            },
            chapterUrl: "https://weebcentral.com/chapters/01KWX62ZXF6VQDFEM1ADY98TFD/",
            sourceId: "weebcentral",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-dyn-001",
                title: "Bloom Into You",
                normalizedTitle: "bloom into you",
                coverUrl: "/sample-covers/bloom-into-you.jpg",
                authors: ["Nio Nakatani"],
                status: "completed",
                sourceId: "dynasty-scans",
                sourceUrl: "https://dynasty-scans.com/chapters/bloom_into_you_ch1",
                sourceMangaId: "bloom_into_you",
                mangaUrl: "https://dynasty-scans.com/series/bloom_into_you",
                addedAt: now - 86400000 * 9,
                updatedAt: now - 3600000 * 6,
                latestChapterId: "seed-dyn-001-ch"
            },
            chapterUrl: "https://dynasty-scans.com/chapters/bloom_into_you_ch1",
            sourceId: "dynasty-scans",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-ac-001",
                title: "Return of the Disaster-Class Hero",
                normalizedTitle: "return of the disaster-class hero",
                coverUrl: "/sample-covers/disaster-class-hero.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "asuracomic",
                sourceUrl: "https://asuracomic.net/series/return-of-the-disaster-class-hero-4dbc9a3a/1",
                sourceMangaId: "return-of-the-disaster-class-hero-4dbc9a3a",
                mangaUrl: "https://asuracomic.net/series/return-of-the-disaster-class-hero-4dbc9a3a",
                addedAt: now - 86400000 * 8,
                updatedAt: now - 3600000 * 3,
                latestChapterId: "seed-ac-001-ch"
            },
            chapterUrl: "https://asuracomic.net/series/return-of-the-disaster-class-hero-4dbc9a3a/1",
            sourceId: "asuracomic",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-as-001",
                title: "Omniscient Reader's Viewpoint",
                normalizedTitle: "omniscient reader's viewpoint",
                coverUrl: "/sample-covers/omniscient-reader.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "asurascans",
                sourceUrl: "https://asurascans.com/comics/omniscient-readers-viewpoint-9182bca3/chapter/1",
                sourceMangaId: "omniscient-readers-viewpoint-9182bca3",
                mangaUrl: "https://asurascans.com/comics/omniscient-readers-viewpoint-9182bca3",
                addedAt: now - 86400000 * 6,
                updatedAt: now - 3600000 * 4,
                latestChapterId: "seed-as-001-ch"
            },
            chapterUrl: "https://asurascans.com/comics/omniscient-readers-viewpoint-9182bca3/chapter/1",
            sourceId: "asurascans",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-oms-001",
                title: "The Beginning After The End",
                normalizedTitle: "the beginning after the end",
                coverUrl: "/sample-covers/beginning-after-end.jpg",
                authors: ["TurtleMe"],
                status: "ongoing",
                sourceId: "asuracomic",
                sourceUrl: "https://asuracomic.net/series/the-beginning-after-the-end/chapter-1",
                sourceMangaId: "the-beginning-after-the-end",
                mangaUrl: "https://asuracomic.net/series/the-beginning-after-the-end",
                addedAt: now - 86400000 * 14,
                updatedAt: now - 3600000 * 9,
                latestChapterId: "seed-oms-001-ch"
            },
            chapterUrl: "https://asuracomic.net/series/the-beginning-after-the-end/chapter-1",
            sourceId: "asuracomic",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-ts-001",
                title: "Kukuku! He is the Weakest of the Four Heavenly Kings",
                normalizedTitle: "kukuku! he is the weakest of the four heavenly kings",
                coverUrl: "/sample-covers/nano-machine.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "thunderscans",
                sourceUrl:
                    "https://en-thunderscans.com/kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden-chapter-1/",
                sourceMangaId:
                    "kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden",
                mangaUrl:
                    "https://en-thunderscans.com/manga/kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden/",
                addedAt: now - 86400000 * 13,
                updatedAt: now - 3600000 * 7,
                latestChapterId: "seed-ts-001-ch"
            },
            chapterUrl:
                "https://en-thunderscans.com/kukuku-he-is-the-weakest-of-the-four-heavenly-kings-i-was-dismissed-from-my-job-but-somehow-i-became-the-master-of-a-hero-and-a-holy-maiden-chapter-1/",
            sourceId: "thunderscans",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-wt-001",
                title: "Daisy: How to Become the Duke's Fiancée",
                normalizedTitle: "daisy: how to become the duke's fiancée",
                coverUrl: "/sample-covers/tower-of-god.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "webtoons",
                sourceUrl:
                    "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/episode-1/viewer?title_no=8579&episode_no=1",
                sourceMangaId: "8579",
                mangaUrl:
                    "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/list?title_no=8579",
                addedAt: now - 86400000 * 12,
                updatedAt: now - 3600000 * 2,
                latestChapterId: "seed-wt-001-ch"
            },
            chapterUrl:
                "https://www.webtoons.com/en/romance/daisy-how-to-become-the-dukes-fiancee/episode-1/viewer?title_no=8579&episode_no=1",
            sourceId: "webtoons",
            chapterTitle: "Episode 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-mh-001",
                title: "Attack on Titan",
                normalizedTitle: "attack on titan",
                coverUrl: "/sample-covers/attack-on-titan.jpg",
                authors: ["Hajime Isayama"],
                status: "completed",
                sourceId: "mangahub",
                sourceUrl: "https://mangahub.io/chapter/shingeki-no-kyojin/chapter-1",
                sourceMangaId: "shingeki-no-kyojin",
                mangaUrl: "https://mangahub.io/manga/shingeki-no-kyojin",
                addedAt: now - 86400000 * 11,
                updatedAt: now - 3600000 * 15,
                latestChapterId: "seed-mh-001-ch"
            },
            chapterUrl: "https://mangahub.io/chapter/shingeki-no-kyojin/chapter-1",
            sourceId: "mangahub",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-ff-001",
                title: "Ogami Tsumiki to Kinichijou",
                normalizedTitle: "ogami tsumiki to kinichijou",
                coverUrl: "/sample-covers/ghost-story.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "fanfox",
                sourceUrl: "https://fanfox.net/manga/ogami_tsumiki_to_kinichijou/c106/1.html",
                sourceMangaId: "ogami_tsumiki_to_kinichijou",
                mangaUrl: "https://fanfox.net/manga/ogami_tsumiki_to_kinichijou/",
                addedAt: now - 86400000 * 20,
                updatedAt: now - 86400000 * 1,
                latestChapterId: "seed-ff-001-ch"
            },
            chapterUrl: "https://fanfox.net/manga/ogami_tsumiki_to_kinichijou/c106/1.html",
            sourceId: "fanfox",
            chapterTitle: "Ch.106",
            sortKey: 106
        },
        {
            manga: {
                id: "seed-ops-001",
                title: "Eleceed",
                normalizedTitle: "eleceed",
                coverUrl: "/sample-covers/eleceed.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "olympustaff",
                sourceUrl: "https://olympustaff.com/series/eleceed/1",
                sourceMangaId: "eleceed",
                mangaUrl: "https://olympustaff.com/series/eleceed",
                addedAt: now - 86400000 * 4,
                updatedAt: now - 3600000 * 10,
                latestChapterId: "seed-ops-001-ch"
            },
            chapterUrl: "https://olympustaff.com/series/eleceed/1",
            sourceId: "olympustaff",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-mf-001",
                title: "One Punch Man",
                normalizedTitle: "one punch man",
                coverUrl: "/sample-covers/one-punch-man.jpg",
                authors: ["ONE", "Yusuke Murata"],
                status: "ongoing",
                sourceId: "mangafreak",
                sourceUrl: "https://ww2.mangafreak.me/Read1_One_Punch_Man_1",
                sourceMangaId: "One_Punch_Man",
                mangaUrl: "https://ww2.mangafreak.me/Manga/One_Punch_Man",
                addedAt: now - 86400000 * 16,
                updatedAt: now - 3600000 * 18,
                latestChapterId: "seed-mf-001-ch"
            },
            chapterUrl: "https://ww2.mangafreak.me/Read1_One_Punch_Man_1",
            sourceId: "mangafreak",
            chapterTitle: "Chapter 1",
            sortKey: 1
        },
        {
            manga: {
                id: "seed-cx-001",
                title: "My Possession Became a Ghost Story",
                normalizedTitle: "my possession became a ghost story",
                coverUrl: "/sample-covers/ghost-story.jpg",
                authors: [],
                status: "ongoing",
                sourceId: "comix",
                sourceUrl: "https://comix.to/title/80d0m-my-possession-became-a-ghost-story/10251750-chapter-0",
                sourceMangaId: "80d0m-my-possession-became-a-ghost-story",
                mangaUrl: "https://comix.to/title/80d0m-my-possession-became-a-ghost-story",
                addedAt: now - 86400000 * 1,
                updatedAt: now - 3600000 * 20,
                latestChapterId: "seed-cx-001-ch"
            },
            chapterUrl: "https://comix.to/title/80d0m-my-possession-became-a-ghost-story/10251750-chapter-0",
            sourceId: "comix",
            chapterTitle: "Chapter 0",
            sortKey: 0
        }
    ]
}
