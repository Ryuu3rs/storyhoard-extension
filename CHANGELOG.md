# Changelog

## [0.29.0](https://github.com/Ryuu3rs/storyhoard-extension/compare/v0.28.0...v0.29.0) (2026-10-04)


### Features

* on-site reading pivot - retire in-app reader, add best-version ranking ([#97](https://github.com/Ryuu3rs/storyhoard-extension/issues/97)) ([2dd76ea](https://github.com/Ryuu3rs/storyhoard-extension/commit/2dd76ea84c3a1b09aea0eaa8f1d69a1dd423b855))

## [0.28.0](https://github.com/Ryuu3rs/storyhoard-extension/compare/v0.27.0...v0.28.0) (2026-09-29)


### Features

* source-independent import + status cards + weeb.ltd deep-link ([#92](https://github.com/Ryuu3rs/storyhoard-extension/issues/92)) ([fa10b55](https://github.com/Ryuu3rs/storyhoard-extension/commit/fa10b553dfe28861b1c6f4443fc31c637771f93d))
* **sources:** add Rolia Scan (roliascan.com) ([#96](https://github.com/Ryuu3rs/storyhoard-extension/issues/96)) ([fc89186](https://github.com/Ryuu3rs/storyhoard-extension/commit/fc89186f2f3f2d9750e08f6c80d3b8fc467bd483))

## [0.27.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.26.0...v0.27.0) (2026-09-26)


### Features

* rebrand to StoryHoard ([#90](https://github.com/Ryuu3rs/AMR-Next/issues/90)) ([8e4d5eb](https://github.com/Ryuu3rs/AMR-Next/commit/8e4d5ebe149f79d37a8a74b291402fa57dacec77))
* **resolver:** manual Find source + adopt (slice 3) ([#88](https://github.com/Ryuu3rs/AMR-Next/issues/88)) ([8fe33f8](https://github.com/Ryuu3rs/AMR-Next/commit/8fe33f8f7e9d5a41e390be85ffd71131344c9029))

## [0.26.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.25.0...v0.26.0) (2026-09-26)


### Features

* **import:** Mangayomi format + ci: decouple AMO submission ([#85](https://github.com/Ryuu3rs/AMR-Next/issues/85)) ([90d4ed7](https://github.com/Ryuu3rs/AMR-Next/commit/90d4ed767e071e4b58c095c580d4dcc70ba8e832))
* **resolver:** source-resolver core (slices 0-2, read-only) ([#86](https://github.com/Ryuu3rs/AMR-Next/issues/86)) ([667fc32](https://github.com/Ryuu3rs/AMR-Next/commit/667fc32eec27a2f992c7acbf918d9ec10b8ece15))

## [0.25.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.24.0...v0.25.0) (2026-09-25)


### Features

* **import:** import Mihon/Tachiyomi libraries for tracking ([#83](https://github.com/Ryuu3rs/AMR-Next/issues/83)) ([6be373a](https://github.com/Ryuu3rs/AMR-Next/commit/6be373a48bfa2bc1e2528a51a91636de8bb83939))

## [0.24.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.23.0...v0.24.0) (2026-09-25)


### Features

* **library:** carry optional canonical workId on library rows ([#81](https://github.com/Ryuu3rs/AMR-Next/issues/81)) ([fb3d441](https://github.com/Ryuu3rs/AMR-Next/commit/fb3d441a9b7bf449fe55759ac77607fd3b8affa1))

## [0.23.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.22.0...v0.23.0) (2026-09-25)


### Features

* **privacy:** default-on usage analytics + canonical privacy policy ([#79](https://github.com/Ryuu3rs/AMR-Next/issues/79)) ([3693775](https://github.com/Ryuu3rs/AMR-Next/commit/369377559be6c1b1f9fd6056f05e074f3fa619e6))

## [0.22.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.21.1...v0.22.0) (2026-09-21)


### Features

* **sync:** sync notes, tags, flags and per-title reader overrides across devices ([b9b7a4e](https://github.com/Ryuu3rs/AMR-Next/commit/b9b7a4e82409b64245da8ef25ab3da93b333e435))
* **tracking:** mark chapters read when opened on the source site ([129508e](https://github.com/Ryuu3rs/AMR-Next/commit/129508e32b8c80e5de363801b43509fa994df336))


### Bug Fixes

* **discover:** search a suggestion's alternate titles so romaji-only manhwa resolve ([295096d](https://github.com/Ryuu3rs/AMR-Next/commit/295096dfc65c5905292eb42cdc7d68e919929605))
* **reader:** read downloaded chapters offline instead of erroring ([d12044e](https://github.com/Ryuu3rs/AMR-Next/commit/d12044ef1157e50a51447534fd377303a95175c6))
* **sync,library:** stamp updatedAt on edits so they push; caught-up un-pauses ([6669283](https://github.com/Ryuu3rs/AMR-Next/commit/6669283da7bb11d36cced85baa684cad21ee4a93))
* **updates:** bucket retired/unlinked/unparseable sources as 'needs relink', not eternal failures ([59479df](https://github.com/Ryuu3rs/AMR-Next/commit/59479df6add7e2d7106a79b326e7971974d25dc1))

## [0.21.1](https://github.com/Ryuu3rs/AMR-Next/compare/v0.21.0...v0.21.1) (2026-09-17)


### Bug Fixes

* **build:** don't stamp the dev-dirty + on tagged or CI release builds ([0c9ee5d](https://github.com/Ryuu3rs/AMR-Next/commit/0c9ee5de7e1031060d1fa88e7ae8c762997dbd6e))

## [0.21.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.20.0...v0.21.0) (2026-09-16)


### Features

* **account:** link a weeb.ltd account and sync the library ([9e2f739](https://github.com/Ryuu3rs/AMR-Next/commit/9e2f7390784f98c08aaebbb411f19a1cf92988fd))
* **account:** link the community id to the weeb.ltd account ([3dcfb42](https://github.com/Ryuu3rs/AMR-Next/commit/3dcfb426f8e341ad6f2c982d6ad168dc784aa8ae))
* **app:** IA refresh - Discover replaces Home, Activity tab, start-page setting ([4965cfc](https://github.com/Ryuu3rs/AMR-Next/commit/4965cfca35f687b0ad4bf079fb53d275a3a4958a))
* **app:** move the weeb.ltd account link into Settings so the site's instructions match ([b2a56e9](https://github.com/Ryuu3rs/AMR-Next/commit/b2a56e90f33affc732ef92ec25550fa5d3713a02))
* **app:** nicer placeholder covers for titles with no/broken image ([49c5a82](https://github.com/Ryuu3rs/AMR-Next/commit/49c5a8275fa47f72e79990b4ebf6cc4c7722b3ca))
* **app:** settings hub with section rail, find-a-setting filter, and card grid ([2b85d24](https://github.com/Ryuu3rs/AMR-Next/commit/2b85d24eea76c28f056cf47502beae16cd9f80da))
* **app:** unify On Hold and Paused; detail modal status cleanup ([272e9d3](https://github.com/Ryuu3rs/AMR-Next/commit/272e9d306eda99794990567f14d507a6e29f2823))
* **app:** weeb.ltd Community nav + footer link, gated on setting and reachability ([cdeb65f](https://github.com/Ryuu3rs/AMR-Next/commit/cdeb65f9d0f815f97fbb687cf7a912b4d3edee36))
* **community:** affiliate click tracking + admin aggregate ([75c4699](https://github.com/Ryuu3rs/AMR-Next/commit/75c4699d846654d8b5bba245f2611f928e865938))
* **community:** consent-gated data collection, GDPR controls, and install counts ([094647b](https://github.com/Ryuu3rs/AMR-Next/commit/094647b34e6328c5c6be15a67d2b40683273a77e))
* **community:** owner announcements + admin dashboard API ([9f48bd9](https://github.com/Ryuu3rs/AMR-Next/commit/9f48bd97a389c23d0c0e803f62346c22d2c841d2))
* **community:** per-chapter read counts, genre backfill across events, and source-suffix title cleanup ([7ca6242](https://github.com/Ryuu3rs/AMR-Next/commit/7ca6242c44d6bcce90370781ecb87e0331fe9845))
* **data:** optional passphrase-encrypted backups (AES-GCM) ([a190efe](https://github.com/Ryuu3rs/AMR-Next/commit/a190efe242828cefafe0ca034e47bb2ecd061e8c))
* **discover:** add community-trending rail ([2385322](https://github.com/Ryuu3rs/AMR-Next/commit/23853224fa1c8c3536bdc532861794dea22ec17b))
* **discover:** add continue-the-series rail from AniList sequels ([6574d7f](https://github.com/Ryuu3rs/AMR-Next/commit/6574d7ff22ce833148c834198860dfc394076b57))
* **discover:** backfill thin suggestion pools with top-genre picks ([0640cb7](https://github.com/Ryuu3rs/AMR-Next/commit/0640cb74878a990987967bcb77a8c36e0f40a3ef))
* **discover:** confirmation toast on quick-add (mark read / plan-to-read) ([c81f674](https://github.com/Ryuu3rs/AMR-Next/commit/c81f674b249c2b18798b250408617e83f1994a69))
* **discover:** Find + More menu to log a suggestion as read or plan-to-read ([2ad6ec5](https://github.com/Ryuu3rs/AMR-Next/commit/2ad6ec558a4bfc2352481a5dabd7bfe1f6e8ee97))
* **discover:** source search in a popover, clearable, self-timing add notice ([92df068](https://github.com/Ryuu3rs/AMR-Next/commit/92df0685a385b35c429069b74dc97e93670a2f07))
* **discover:** weight by AniList rec strength, add hidden-gems rail ([fa8ab49](https://github.com/Ryuu3rs/AMR-Next/commit/fa8ab492988db8a63af9d388ad603a29a365ac29))
* **discover:** weight recs by rating/status, add not-interested + mix-it-up ([f5a9a2a](https://github.com/Ryuu3rs/AMR-Next/commit/f5a9a2a1af6b1e3348076dd487b9a1b20e998b8d))
* **library:** bulk set status in Select mode ([e80e0aa](https://github.com/Ryuu3rs/AMR-Next/commit/e80e0aa922912c9b9f3184f7b27533b497c466fd))
* **library:** escalate the filter box to an all-source search ([e0f6949](https://github.com/Ryuu3rs/AMR-Next/commit/e0f6949239ebe408cc8118def7ce225fd2256131))
* **library:** manual genre/metadata backfill; tags vs genres finalized ([0a1adc3](https://github.com/Ryuu3rs/AMR-Next/commit/0a1adc3d7142aa78a42061fbd7e594d1be698168))
* **library:** updates-first default, status counts, New/New-ch badges, Tools menu ([d3da2a1](https://github.com/Ryuu3rs/AMR-Next/commit/d3da2a16e284cca38e820a38730f2ee67a0ee2bf))
* **popup:** unread-first library overview in the toolbar popup ([330f48e](https://github.com/Ryuu3rs/AMR-Next/commit/330f48e9dfcc588a9e37dd6e91f43f8e30b78043))
* **reader:** default view setting, per-title page-width override, fix fast-click page jump ([ab652cd](https://github.com/Ryuu3rs/AMR-Next/commit/ab652cddf9d9364d8799311698b913cab7eecc36))
* **sources:** add DragonTea with novel URLs and per-site Ko-fi links ([6a5fe74](https://github.com/Ryuu3rs/AMR-Next/commit/6a5fe74ff6a7c5ffbf5803666b5532ef3f0f7dfe))
* **sources:** add Nyanu Kafe (nyanukafe.com) ([a309361](https://github.com/Ryuu3rs/AMR-Next/commit/a3093612fc56eaa1a54ec5d7b486b4e85a8526f2))
* **sources:** tip links for LHTranslation, MangaSushi, Nyanu Kafe, Tritinia, Flame Comics ([4ff95f0](https://github.com/Ryuu3rs/AMR-Next/commit/4ff95f0d3c975f6e124cfc8cc842f400c520031a))


### Bug Fixes

* **app:** center Community nav entry to match other sidebar items ([27b1e22](https://github.com/Ryuu3rs/AMR-Next/commit/27b1e22a6acaf85b5895c9ae0bee3f7b79cb1cea))
* **community:** allowlist title normalization, safe chapter dedup, rating alignment ([b119269](https://github.com/Ryuu3rs/AMR-Next/commit/b1192695c9cbb2c705a3482329d055d3fd36e937))
* **community:** guard /events shape, serialize tombstones, fix sync boundary, guard json_each ([8532287](https://github.com/Ryuu3rs/AMR-Next/commit/8532287f15f0acf9effdc1c1c2b8c316e6cd3e62))
* **deps:** bump hono 4.13.5 + @hono/node-server 1.19.17 (moderate CVEs) ([4f8001a](https://github.com/Ryuu3rs/AMR-Next/commit/4f8001a665f92a11bc77f345183a90da9ed22f1d))
* **discover,library,updates:** podium sizing, select-mode checkbox + bulk caught-up, de-conflate bot-block skips ([2e0186e](https://github.com/Ryuu3rs/AMR-Next/commit/2e0186e91dd600e30b19b7a204852fed6685a838))
* **discover:** don't blank the page when a refresh can't reach AniList ([acd3764](https://github.com/Ryuu3rs/AMR-Next/commit/acd376471816e49a1c748ace1f73582bd36402f1))
* **discover:** fixed-size centered podium, full-width layout, centered top controls ([00a41cd](https://github.com/Ryuu3rs/AMR-Next/commit/00a41cd449d3ca32f5e746c14f3d0e850a950c1d))
* **discover:** keep quick-added titles out of suggestions (no stale-cache flash-back) ([d732952](https://github.com/Ryuu3rs/AMR-Next/commit/d7329528ef601f642217eb29e2844c182f5211bb))
* **discover:** quick-add sent a Svelte $state proxy array (unclonable) - spread genres to a plain array ([fbc1b0d](https://github.com/Ryuu3rs/AMR-Next/commit/fbc1b0d4720ab3db3731c4016e576ec9b164ce08))
* **discover:** stop full-width main overflowing the shell horizontally ([625c0e4](https://github.com/Ryuu3rs/AMR-Next/commit/625c0e4559f9219dc2274b7e0a77960ec6d14576))
* **discover:** visible Mix it up toggle, editor-picks cold-start empty state ([0dc64c2](https://github.com/Ryuu3rs/AMR-Next/commit/0dc64c23420457c5a4289e991d2af957397c9195))
* **library:** don't flag already-read Discover adds as needing a source ([61921cf](https://github.com/Ryuu3rs/AMR-Next/commit/61921cf66a187b9da3c878c316831de234ad99ea))
* **library:** responsive duplicate merge + keep-source picker ([9327468](https://github.com/Ryuu3rs/AMR-Next/commit/93274682810a6dfb10ea0a10f166ae6023f5ec8e))
* **nyanukafe:** parse the full chapter anchor (real inners are ~1.4KB, not &lt;400) ([07a5544](https://github.com/Ryuu3rs/AMR-Next/commit/07a554477f633a009d7ef0cb7c91f79ccb58f36f))
* **privacy:** point policy URL at the live host privacy.weeb.ltd ([2613b11](https://github.com/Ryuu3rs/AMR-Next/commit/2613b11d7a502d0b9312ccd5f6c3a1b5141e7467))
* **reader,discover:** bughunt fixes - preserve per-title width, show empty search, onboarding on cold start ([989dcda](https://github.com/Ryuu3rs/AMR-Next/commit/989dcda6174b7036bdb3ad30bd6be2d4c8bb512f))
* **reader:** capture JS-injected pages in tab render (MangaHub truncation) ([1ddfd44](https://github.com/Ryuu3rs/AMR-Next/commit/1ddfd444983c7a1418324eb91010cf85495e1fae))
* **reader:** immersive top bar so it stops limiting image size ([6888a54](https://github.com/Ryuu3rs/AMR-Next/commit/6888a54d79544e4de77e0943c883c91548d67bc1))


### Performance Improvements

* **suggestions:** cache AniList recommendations per seed to stop hammering AniList ([e6726f4](https://github.com/Ryuu3rs/AMR-Next/commit/e6726f489efcc562209f3e7b440a2248e3dbfbb7))

## [0.20.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.19.0...v0.20.0) (2026-08-23)


### Features

* **anilist:** bidirectional reading-status sync (push/pull, last-writer) ([b261a00](https://github.com/Ryuu3rs/AMR-Next/commit/b261a0042c5e9ad1c5cdea964e0436a042d6cf41))
* **anilist:** import completed titles as completed + planning opt-out ([5df2e6b](https://github.com/Ryuu3rs/AMR-Next/commit/5df2e6baf683059f95721ca4d8d80baec8de5647))
* **discover:** lead with top picks + genre filter; align card buttons; show build marker ([9de9a75](https://github.com/Ryuu3rs/AMR-Next/commit/9de9a7569fffcf1dfb7b80c8893744e9998a82ef))
* **discover:** rename Suggestions to Discover with because-you-read + genre rails and find-similar ([b7412f7](https://github.com/Ryuu3rs/AMR-Next/commit/b7412f7b7d79ceca51ddd5ec0606725a59bea44d))
* **library:** add 'Updates' filter for titles with new chapters; scope Find better sources ([0f176be](https://github.com/Ryuu3rs/AMR-Next/commit/0f176becfcd5a13fc8bc7257b07b5cd1757372f1))
* **library:** detect rotated-slug duplicates so the merge tool catches Asura forks ([3d17bb0](https://github.com/Ryuu3rs/AMR-Next/commit/3d17bb00f20b54ed99b073cedd8ea736187bb092))
* **reader:** Actual-size fit (native resolution), configurable double-page gap, fix stray x-overflow ([31fc7da](https://github.com/Ryuu3rs/AMR-Next/commit/31fc7da4383f0e2cd8b37865d176fa5bd9334e47))
* **reader:** add Fill width page-fit so pages fill the screen (no lateral borders) ([db6b31f](https://github.com/Ryuu3rs/AMR-Next/commit/db6b31f7f302c2795be2e4e9b9f23dedf7230eee))
* **reader:** filter chapter list and prev/next by preferred language ([fbccdc7](https://github.com/Ryuu3rs/AMR-Next/commit/fbccdc70abee014d1d57757018ed5bd9ae9defd0))
* **reader:** make Double-page a paged flip view (arrows + wheel), not a scroll ([4f38275](https://github.com/Ryuu3rs/AMR-Next/commit/4f382753cdbb92e5493dfad0b9f047c86b1828a9))
* **reader:** make Fit width actually fill; add a Page width slider ([5aa1b3d](https://github.com/Ryuu3rs/AMR-Next/commit/5aa1b3d5080a91641c60474e52b2b8be265acfb4))
* **seed:** give recognizable sample titles real AniList ids so Discover demonstrates ([ac72f33](https://github.com/Ryuu3rs/AMR-Next/commit/ac72f3371a697a1eab760c2daa5309bf3f6f7e2c))
* **suggestions:** filter the Suggested tab by genre, title, community, and sort ([34f4047](https://github.com/Ryuu3rs/AMR-Next/commit/34f4047e46a3999ff324d82b2fae49c98f6a97c8))
* **updates:** in-app download button for the matching browser build ([34602bd](https://github.com/Ryuu3rs/AMR-Next/commit/34602bdfccc89040eef409922b0b094980bf7691))


### Bug Fixes

* **anilist/webtoons:** dedup custom-list import entries; scope webtoons next-page + guard episode_no ([7513735](https://github.com/Ryuu3rs/AMR-Next/commit/7513735b6b9de7dab63b5f1b9dc8b25ac573d5df))
* **anilist:** base status-sync explicit flag on the resolved kind, not raw readingStatus ([ae7beb5](https://github.com/Ryuu3rs/AMR-Next/commit/ae7beb577dda033f1c87ec30b8c78a3629764617))
* **anilist:** gate completed on real publication status; skip light novels; import nsfw + authors ([0cd8992](https://github.com/Ryuu3rs/AMR-Next/commit/0cd8992413899ba0933959a9a6e2191f66507cb6))
* **asura:** stop duplicate library entries on slug rotation; dedupe chapter-count stats ([4bfbea8](https://github.com/Ryuu3rs/AMR-Next/commit/4bfbea81f785f4d0297db488c02c9c953f80cdf7))
* **asura:** track reader progress + stop duplicate/renamed entries under slug rotation ([00e396c](https://github.com/Ryuu3rs/AMR-Next/commit/00e396cbf4d31ba9f22d384c9091db5c71125b84))
* **bookmarks:** star the right page/chapter, guard orphans, make toggle atomic ([2300e22](https://github.com/Ryuu3rs/AMR-Next/commit/2300e22c2e89fe32ce1c591e14aa584aba683dfc))
* bughunt sweep of the 0.20.0 diff (AniList sync, backfill, reader capture) ([b601b24](https://github.com/Ryuu3rs/AMR-Next/commit/b601b24ed474a0795b9fbb4b2cbbc215c253172c))
* **capture:** clear internal-tab markers after tab removal; retry slug-title recovery on later visits ([140b6c5](https://github.com/Ryuu3rs/AMR-Next/commit/140b6c5661e3d106744ec7b3a1d75e376eccb5f0))
* **comix:** canonicalise resolveChapter id to match listChapters (no duplicate rows) ([afd02d8](https://github.com/Ryuu3rs/AMR-Next/commit/afd02d89494bea0a74b2ce2a578bed020b27c0e5))
* **comix:** populate the chapter list via a manga-page tab render so on-page prev/next works ([2790228](https://github.com/Ryuu3rs/AMR-Next/commit/27902286b52e6076ad7f68e9bb9c97ebb2bcdb46))
* **comix:** seed on-page prev/next from the page's own SSR data ([4439cb8](https://github.com/Ryuu3rs/AMR-Next/commit/4439cb8b1fe8c58f6f138d467bc4782a056b10f4))
* **diagnostics:** log update-check runs and embed a library/unread snapshot ([85cc51e](https://github.com/Ryuu3rs/AMR-Next/commit/85cc51e8022b798ff89de34ed4c9ecf1a7d69ab9))
* **diagnostics:** stop redacting the public community username in the log ([6bf6833](https://github.com/Ryuu3rs/AMR-Next/commit/6bf6833178ecf26bd49167a1331ba2c78bb87658))
* **library:** back up before merge; stop four paths orphaning rows after a concurrent remove ([d63c720](https://github.com/Ryuu3rs/AMR-Next/commit/d63c7206da2844a2acc9ca936fc11a26743bcac8))
* **library:** refresh stale ongoing status so finished series reach Completed; scope siblings to one language ([1d53faa](https://github.com/Ryuu3rs/AMR-Next/commit/1d53faa8a8815068381fd414da913111f5220701))
* **library:** stop the 'lost progress' mislabels - New-ch badge + real chapter number in reader ([d3c9c57](https://github.com/Ryuu3rs/AMR-Next/commit/d3c9c57663f1e0783e87040474bd66a04f9f1857))
* **mangadex:** dedupe chapters to one row per number; thread reading language ([302b440](https://github.com/Ryuu3rs/AMR-Next/commit/302b4407027986320cbcbd4e366acc6782d49427))
* **mangahub:** heal poisoned chapter numbers locally + drop phantom next chapter ([a97d103](https://github.com/Ryuu3rs/AMR-Next/commit/a97d1033a99af6ebaddd8ed20bc09d775818d28e))
* **mangahub:** resolve all chapter pages, not just the lazy-load preload window ([459a91f](https://github.com/Ryuu3rs/AMR-Next/commit/459a91f6b099077afa615df898a4dbf52d7455bc))
* **metadata:** treat AniList's 404 no-match as null; reject combining-mark-only usernames ([192e0ed](https://github.com/Ryuu3rs/AMR-Next/commit/192e0edd92089e26b7340399e08b6ecaae653f78))
* **reader/stats:** double-page completion, page-index clamp, single-page broken banner, merge history dedup ([dc0e3fe](https://github.com/Ryuu3rs/AMR-Next/commit/dc0e3fe3efe2c445b5e374eeb3faa64e2c799a1c))
* **reader:** capture chapter identity before offline export/remove awaits ([12430f1](https://github.com/Ryuu3rs/AMR-Next/commit/12430f11ddf68bb6a7a2e95dd36d1b133364a074))
* **reader:** guard offline download against orphaning, fix stale-chapter races, wrap alarm dispatches ([fdd28aa](https://github.com/Ryuu3rs/AMR-Next/commit/fdd28aa4b90296e54474d3341131f8fa41c0f4c2))
* restore anchor-fallback specials, stop backup restore dropping titles, chunk community sync ([b74e43e](https://github.com/Ryuu3rs/AMR-Next/commit/b74e43eae10d8d080fe62766373827fac37b075d))
* **search:** count source settlements, not matches, in the progress indicator ([ca9cc38](https://github.com/Ryuu3rs/AMR-Next/commit/ca9cc380c4fe5adec9aa38bcf18f5ada34f50c34))
* **search:** guard chapter-list load against stale responses; pin the auto-expanded group ([76f4b14](https://github.com/Ryuu3rs/AMR-Next/commit/76f4b146b9ed17001ed7cd0fb433a21ec7f07089))
* **security:** scope anchor-fallback to the series, redact the log snapshot, guard comix Next, clear Discover focus ([691fd12](https://github.com/Ryuu3rs/AMR-Next/commit/691fd12bc463575d339dce5456e8b0f2e730ccd0))
* **server:** rate-limit metadata + community read endpoints and cap free-text input ([5f02480](https://github.com/Ryuu3rs/AMR-Next/commit/5f024802aa3cf57d9a8afd7479384a95ed9b33bc))
* **sources:** recover ts-variant chapter lists via anchor fallback; retire 4 dead adapters ([abd7f9a](https://github.com/Ryuu3rs/AMR-Next/commit/abd7f9af8950b13acb2c714611d940951cec7201))
* **stats:** label the all-time Active-days stat so it doesn't contradict the recent heatmap ([4141898](https://github.com/Ryuu3rs/AMR-Next/commit/41418982dc0898e5e8e239d328e86ca1305c6539))
* **stats:** stop in-place sort of a reactive array in the template (Stats tab dead on return) ([d992935](https://github.com/Ryuu3rs/AMR-Next/commit/d9929356ad46e0326d0d082a7bb6eb2a2070fda0))
* **thunderscans:** follow series path move /manga -&gt; /comics; refresh stale health-targets ([e94fc49](https://github.com/Ryuu3rs/AMR-Next/commit/e94fc4905ffbf803ac5fbf7d84e360401d8232c6))

## [0.19.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.18.0...v0.19.0) (2026-08-08)


### Features

* **anilist:** import titles by romaji first so mirror search matches more sources ([b473d46](https://github.com/Ryuu3rs/AMR-Next/commit/b473d4642a11871246e17f2526a0a2e4af70c36a))
* **backup:** daily automatic restore point with partitioned retention ([c2f4f9f](https://github.com/Ryuu3rs/AMR-Next/commit/c2f4f9f47b772a2e3b308cc98c96c1a94ea29380))
* **community:** reserved-name blocklist + emoji-safe username validation ([65e3d25](https://github.com/Ryuu3rs/AMR-Next/commit/65e3d2543f02ec9a154072dab84db193f9a88354))
* **insights:** Stats genre breakdown + Suggestions top-3 podium from the library genre profile ([f0eac9d](https://github.com/Ryuu3rs/AMR-Next/commit/f0eac9d56e1db0370d3d8a9195add9c7816d7b56))
* **library:** persist sort, cap suggestions, auto-backup on update ([dfc7ecb](https://github.com/Ryuu3rs/AMR-Next/commit/dfc7ecb700dd6a0dfbe927e8f787593425cad7a9))
* **library:** reading-status filters, per-title status control, auto-pause + import settings ([7882597](https://github.com/Ryuu3rs/AMR-Next/commit/7882597bba822941c84d05bf3b83e8ed9537a488))
* **library:** reading-status model (paused/dropped/planning), AniList status mapping, auto-pause, sync reconcile ([1267824](https://github.com/Ryuu3rs/AMR-Next/commit/1267824a994ebb343884c4a203c79d3d48600700))
* **reader:** seamless 0-gap spread toggle, fit-height clip, top-bar autohide hotkey ([0fce270](https://github.com/Ryuu3rs/AMR-Next/commit/0fce27052ac7e9f12f981323b76e7d0b7793ad60))
* **reader:** Strip/Single/Double view control, scrollable double spreads, page nav ([973c755](https://github.com/Ryuu3rs/AMR-Next/commit/973c755691991ffc8b9f7cd0ed265285c15a36ec))
* **reader:** tighten the double-page spread and add a first-page offset ([6a1e864](https://github.com/Ryuu3rs/AMR-Next/commit/6a1e864d3e89983ea4718986e630d39fd21be9a0))
* **search:** add library:add so primary click adds any source unread ([60c480e](https://github.com/Ryuu3rs/AMR-Next/commit/60c480eb80f471d508597a23273334c50829d31c))
* **search:** per-source search toggle on Sources tab (preferred mirrors) ([e8b2a5b](https://github.com/Ryuu3rs/AMR-Next/commit/e8b2a5bc9e48510cfde17fccce98a77375f0a93c))
* **search:** primary click adds result to library, modifier-click opens site ([d111b21](https://github.com/Ryuu3rs/AMR-Next/commit/d111b2125e2e15c3a6938661cd0d94db83b4c7d9))
* **sources:** add GD Scans (Madara) with optional volume-path chapter URLs ([c19f049](https://github.com/Ryuu3rs/AMR-Next/commit/c19f049059205f585285cb0071435a416faa58bb))
* **sources:** add mangak.io adapter (Next.js SSR: search + chapter list + reader scrape) ([eedc97f](https://github.com/Ryuu3rs/AMR-Next/commit/eedc97f25af8226d1fe4e6075cecc2ce6df11432))
* **sources:** alias tritinia.com to recover old-domain imports ([1ee9c85](https://github.com/Ryuu3rs/AMR-Next/commit/1ee9c85ada86d1b322536820f32386de1f04cddf))


### Bug Fixes

* **anilist:** make sync reconcile safe (up-front fetch, empty-guard, pre-existing-id snapshot) so it never mass-drops the library ([3b8655a](https://github.com/Ryuu3rs/AMR-Next/commit/3b8655a1c2c9f8d91a7141e4f61202b766cbd3ba))
* **anilist:** track known-membership across syncs so reconcile only drops genuine removals, never enrichment-stamped titles ([43e36b9](https://github.com/Ryuu3rs/AMR-Next/commit/43e36b95a2a698062ca6e075b8e8c296d8d7c0bf))
* **asura:** strip 'Chapter N' suffix from resolved series title ([9cb5e17](https://github.com/Ryuu3rs/AMR-Next/commit/9cb5e172b9cd60e80131a64f419fbf8c0e68d4cf))
* **background:** reset stuck update-progress on throw; update-pending latch; ensureAlarm no period-reset; focus existing dashboard tab ([16066fd](https://github.com/Ryuu3rs/AMR-Next/commit/16066fd1d8e6af3b811ad21715f3f05445d1337d))
* **capture:** mark-read adds a distinct library entry per title ([9663473](https://github.com/Ryuu3rs/AMR-Next/commit/9663473f597240877d6f6541e836afa65a462747))
* **community-server:** vendor username rules so the isolated Docker build resolves ([6232319](https://github.com/Ryuu3rs/AMR-Next/commit/6232319619e596a6cb6990882ba99afe246fb439))
* **db:** preserve anilistId/genres/metadataUpdatedAt/latestChapterAt on chapter recapture ([2db9b2e](https://github.com/Ryuu3rs/AMR-Next/commit/2db9b2eb95ee19e0bf78c5cfca50c309dff0e974))
* **db:** v11 heals Infinity lastReadChapterNumber; guard latest-chapter pick; clear dangling read id on switch; backup signature covers metadata ([7ca8d0b](https://github.com/Ryuu3rs/AMR-Next/commit/7ca8d0b9ebbd3fa5e4d221b6e94e6a13a8df4ceb))
* **insights:** emphasize 1st podium pick with an accent ring instead of scale (no overlap) ([ed7d8db](https://github.com/Ryuu3rs/AMR-Next/commit/ed7d8dbb6337e6c1a1be84146a02dfeb09b8cf8c))
* **library:** Completed requires a finished series (caught-up ongoing stays reading) so mark-read titles stay visible in Ongoing ([9e83aea](https://github.com/Ryuu3rs/AMR-Next/commit/9e83aea30daba41c4853d2a1555b01a7636b3c63))
* **library:** don't mark read titles Completed when latest is unknown; status-aware Surprise Me + updates badge ([c2efb76](https://github.com/Ryuu3rs/AMR-Next/commit/c2efb76071fb1c009a55d8e775012a3432a84015))
* **mangahub:** reject internal-id chapter numbers in external-track + heal poisoned lastReadChapterNumber so Updates shows real numbers ([c94e7af](https://github.com/Ryuu3rs/AMR-Next/commit/c94e7af09b0c61c014cddc0316384821c794d1f1))
* **reader:** center image at original page-fit (center + margin-auto, not safe-center) ([5e4edc4](https://github.com/Ryuu3rs/AMR-Next/commit/5e4edc4d063f1ee03d18825241f86c999d056f49))
* **reader:** retry a failed page image (backoff) before stranding it on alt text ([93fe88f](https://github.com/Ryuu3rs/AMR-Next/commit/93fe88fd4b542a90c888667c24eef0055e82776e))
* **search:** honor per-source race timeout in streaming; force refreshes suggestions; validate library:add input ([0ad4d6b](https://github.com/Ryuu3rs/AMR-Next/commit/0ad4d6bfb4a15e2187bc38654a5e20dd751a02a7))
* **search:** raise bulk-search race timeout to 10s so it stops missing sources a manual search finds ([8851854](https://github.com/Ryuu3rs/AMR-Next/commit/8851854708d22291c0c19c70f266a4465a60a866))
* **search:** unicode-aware matchesQuery + normalizeTitle (NFC/strip); chapterIdToken uses query key for webtoons ([001f668](https://github.com/Ryuu3rs/AMR-Next/commit/001f66884deb987432fe0afa1fad7c4bed686199))
* **security:** redact encoded secrets + JWTs in diag log; http(s)-only url guard; strip control chars from cbz filename ([e6c1b01](https://github.com/Ryuu3rs/AMR-Next/commit/e6c1b0109e42c6ae73663c31e9e59eff00c7e8ed))
* **sources:** dash-decimal chapters, weebcentral year misparse, asura bare-chapter title, sortkey edge cases ([cc190c0](https://github.com/Ryuu3rs/AMR-Next/commit/cc190c08c07f79a0c5433929285c4e9b731e6852))
* **sources:** mangadex newest-500, comix chapter-0, fanfox search dupe-slug, manganato genre scoping, mgeko unnumbered ([8d3a19e](https://github.com/Ryuu3rs/AMR-Next/commit/8d3a19eb5e8860f5b238f9cfb379a525d023834a))
* **tritinia:** use ch- chapter prefix so reader resolves chapter URLs ([6bca001](https://github.com/Ryuu3rs/AMR-Next/commit/6bca00195eff37d757b59e89b16b7a0a38952289))
* **weebcentral:** parse Episode-labeled chapters so numbers stop collapsing to 0.NNN ([9c78764](https://github.com/Ryuu3rs/AMR-Next/commit/9c78764569ec305b7d370c1677cb85d2aeac9d82))


### Performance Improvements

* **suggestions:** paginated infinite-scroll render + lazy cover images ([37ba2bc](https://github.com/Ryuu3rs/AMR-Next/commit/37ba2bc6be25bbcae3c27faedfdcad01c7aeb4df))
* **suggestions:** serve cached list instantly and revalidate in the background ([00fa24e](https://github.com/Ryuu3rs/AMR-Next/commit/00fa24e01c1d8c9f3b839479fcef7192afcb91a7))

## [0.18.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.17.0...v0.18.0) (2026-08-04)


### Features

* **anilist:** import your AniList list into the library ([08c9a36](https://github.com/Ryuu3rs/AMR-Next/commit/08c9a3647619f5398cff1b5b36236243586cc3a5))
* **app:** AniList import button and inline tag management ([a62a44a](https://github.com/Ryuu3rs/AMR-Next/commit/a62a44a4fe2016ca2ee54e0ce567b9a998d10ae2))


### Bug Fixes

* **background:** stop crawl churn, tab races and uncancellable search ([6448535](https://github.com/Ryuu3rs/AMR-Next/commit/6448535cbdd698746133609dc825e31bfe84bfeb))
* **covers:** metadata-fallback robustness + AniList import/open guards ([59b4a37](https://github.com/Ryuu3rs/AMR-Next/commit/59b4a37bd0d2f77d93ea99a750e8f417f6cfe677))
* **covers:** recover missing covers from the metadata catalog ([36aadb2](https://github.com/Ryuu3rs/AMR-Next/commit/36aadb2337c11bf90356571edc5e16c5db8dfe82))
* **db:** close import-dedup, progress-ratchet and merge/restore integrity holes ([de94907](https://github.com/Ryuu3rs/AMR-Next/commit/de9490793a28ffe44d5db163e0583ef26734b4b2))
* **reader:** paging, download-state race, progress regression, cleanup ([168ac29](https://github.com/Ryuu3rs/AMR-Next/commit/168ac29332755ae181d055820f34f79ddf3b6a0f))
* **reader:** resume at the last-read chapter, not the latest ([eacb038](https://github.com/Ryuu3rs/AMR-Next/commit/eacb03886dac636ffbe7f36bf006dd1cd27117f9))
* **server:** harden rate limiter and recommender/admin privacy ([0549708](https://github.com/Ryuu3rs/AMR-Next/commit/0549708510c74727bbe6e6c9ae8a57e0edba180b))
* **settings:** keep the update-schedule selection after leaving the tab ([0d31b06](https://github.com/Ryuu3rs/AMR-Next/commit/0d31b06e233317f5ab89b67ca2a48df324f3fc81))
* **sources:** correct chapter parsing in madara, comix and mangapark ([4b634b7](https://github.com/Ryuu3rs/AMR-Next/commit/4b634b725d14e67d548e7b358cabcf2297ec692f))

## [0.17.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.16.0...v0.17.0) (2026-08-02)


### Features

* **anilist:** guide access-token setup in settings ([a5e3d1a](https://github.com/Ryuu3rs/AMR-Next/commit/a5e3d1a1673334e4740ee9ccba48ff830bf9e921))
* **anilist:** make the setup authorize URL copyable ([a3c497c](https://github.com/Ryuu3rs/AMR-Next/commit/a3c497c6d0ef31031e74fd6ef989285721da4f82))
* **community:** rank readers-also-read recommendations by co-occurrence ([8b83802](https://github.com/Ryuu3rs/AMR-Next/commit/8b838020b452328696129c1291a4020dc37d29bb))
* **library:** add a "recently updated" sort ([c9dd9ec](https://github.com/Ryuu3rs/AMR-Next/commit/c9dd9ecb758bed8d379a908490f43072b07c3216))
* **metadata:** add Jikan (MAL) fallback for covers and MAL ids ([4166b86](https://github.com/Ryuu3rs/AMR-Next/commit/4166b8640441fd4daae2bf0804545d106a4067d0))
* **reader:** add a double-page (2-up) spread in paged mode ([050e7da](https://github.com/Ryuu3rs/AMR-Next/commit/050e7da5a6982581518b8b90fe98a0aa2ac49245))
* **search:** collapse duplicate results across mirrors into work cards ([207f04b](https://github.com/Ryuu3rs/AMR-Next/commit/207f04bebfb48db46e28ec37e486bb74e502b5ad))
* **suggestions:** add a content-based Suggestions tab ([6a51378](https://github.com/Ryuu3rs/AMR-Next/commit/6a51378eda10075f25a2a5e1f82d37af51a82aa6))
* **updates:** notify on new chapters after an update check ([e5a064f](https://github.com/Ryuu3rs/AMR-Next/commit/e5a064fe7e6475310b1f516194c1e7774db00785))


### Bug Fixes

* **anilist:** put the token box below the setup steps ([aefbee2](https://github.com/Ryuu3rs/AMR-Next/commit/aefbee27fa292e9456d966094e72f0b23ff2bcfe))
* **community:** block the co-read intersection leak with a k-anonymity floor ([9921c1b](https://github.com/Ryuu3rs/AMR-Next/commit/9921c1b38e39f6ae0e5832d1e489d0ba6d39c7e6))
* **community:** reach the community server from the shipped build ([667d48e](https://github.com/Ryuu3rs/AMR-Next/commit/667d48e7801696b1ea63f507bd351228867699ea))
* **reader:** make the double-page spread lay out side by side ([1bceb14](https://github.com/Ryuu3rs/AMR-Next/commit/1bceb143640fd96214bcdfe330ff3c0befa3b528))
* **sources:** restore AsuraScans and Flame Comics update checks ([b423188](https://github.com/Ryuu3rs/AMR-Next/commit/b423188006fd5f5a4e28f2cf82b56f0d9dcb0381))
* **suggestions:** harden grouping and the handler after a bug hunt ([e175f13](https://github.com/Ryuu3rs/AMR-Next/commit/e175f13b538670fdc28991410e8eddba7f1d40a4))
* **updates:** make failure-log counts honest and add a per-source tally ([c897c26](https://github.com/Ryuu3rs/AMR-Next/commit/c897c26814677d33ebe98602c8412d8bcc7a6528))

## [0.16.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.15.0...v0.16.0) (2026-08-02)


### Features

* add exportable diagnostic log ([24ddbe9](https://github.com/Ryuu3rs/AMR-Next/commit/24ddbe9efa442bbac372a23d84c5ebc1cbdda67f))
* add self-hosted metadata catalog service and vps provider ([ce0326a](https://github.com/Ryuu3rs/AMR-Next/commit/ce0326a88277af4973bb13fe37cac820e46c934e))
* enrich manga status, cover and genres from AniList ([fda3785](https://github.com/Ryuu3rs/AMR-Next/commit/fda37851266ad4bbcaa6fedfe0a04783b7035233))
* mirror library membership to AniList ([c5fa0ca](https://github.com/Ryuu3rs/AMR-Next/commit/c5fa0ca940681e6004c8ba41e1ef2e9223c54c36))
* sync read progress to AniList ([19e915d](https://github.com/Ryuu3rs/AMR-Next/commit/19e915d1c6a21e3ee365671b24411437ea761a38))


### Bug Fixes

* adapter unnumbered-chapter sortKey and HTML entity-decoder crash ([db3df6a](https://github.com/Ryuu3rs/AMR-Next/commit/db3df6a607a8afec27b22bc108a578f30f42393c))
* bug-hunt findings across the AniList/import/log changes ([19afd05](https://github.com/Ryuu3rs/AMR-Next/commit/19afd059647adfb803932023807affb764c24cf2))
* don't let a transient AniList outage poison the metadata cache ([eeb9db1](https://github.com/Ryuu3rs/AMR-Next/commit/eeb9db10d149bd80070f83f708fc6565d0731e66))
* fetch the full Weeb Central chapter list ([f4fc279](https://github.com/Ryuu3rs/AMR-Next/commit/f4fc279e12675dca7b520e1517851635264584af))
* harden metadata + community servers ([4106925](https://github.com/Ryuu3rs/AMR-Next/commit/41069254a7ed8a8454714adf16ef3e9dfe768dba))
* import legacy page bookmarks ([5161d0a](https://github.com/Ryuu3rs/AMR-Next/commit/5161d0aaa15c3505b3bc3eca0c6851634325704c))
* import/merge/progress data-integrity holes ([acc559c](https://github.com/Ryuu3rs/AMR-Next/commit/acc559c74ec39fd1d1f0ca306927d361e55c3e30))
* make community reading-history sync opt-in ([02ea77e](https://github.com/Ryuu3rs/AMR-Next/commit/02ea77e7304454c5495181e431f49e7d646d4c35))
* preserve and recover read position for numberless imports ([c9ee034](https://github.com/Ryuu3rs/AMR-Next/commit/c9ee03473dec2edcbb61d1d193c66433af5ac906))
* recover more read progress from legacy imports ([5595689](https://github.com/Ryuu3rs/AMR-Next/commit/55956893b2be1590b18ad9b4fa7f61bbb8d8aa6c))
* restore read progress when switching or reconciling a source ([521b378](https://github.com/Ryuu3rs/AMR-Next/commit/521b3784b8e0bb38645b5afc6fc871310563b6d0))
* revert library/settings controls when their write fails ([574adba](https://github.com/Ryuu3rs/AMR-Next/commit/574adbabe305029ed0b0569f1bc3d5575cf9b23a))
* show read state for unnumbered titles like oneshots ([ad63a71](https://github.com/Ryuu3rs/AMR-Next/commit/ad63a71664092d5cf279163966796267b6de153a))

## [0.15.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.14.1...v0.15.0) (2026-07-31)


### Features

* add MangaKatana source ([5fca877](https://github.com/Ryuu3rs/AMR-Next/commit/5fca8772130e14d3eeef17a22d02f9765622c491))


### Bug Fixes

* add parseMangaUrl to comix/asurascans/madara/mangastream ([335d3c2](https://github.com/Ryuu3rs/AMR-Next/commit/335d3c21711da93990da96c3572c813b38858eb2))
* heal external-track metadata for URL-added titles ([5ebe410](https://github.com/Ryuu3rs/AMR-Next/commit/5ebe410c193036ddaec34d207ee5ebe0f535b2b5))

## [0.14.1](https://github.com/Ryuu3rs/AMR-Next/compare/v0.14.0...v0.14.1) (2026-07-31)


### Bug Fixes

* mangahub title added by URL no longer becomes "Chapter" ([0df1451](https://github.com/Ryuu3rs/AMR-Next/commit/0df1451b293d13392921006b24b084fc34188127))

## [0.14.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.13.0...v0.14.0) (2026-07-24)


### Features

* confirm step before bulk-removing titles ([1825993](https://github.com/Ryuu3rs/AMR-Next/commit/1825993815a5c2a7f81c57f873eee70b049f48b0))
* copy-paste failure log on the updates page ([ba7f398](https://github.com/Ryuu3rs/AMR-Next/commit/ba7f3988254d8a76fa75e2719d68a1f6e2a665ac))
* select-all in bulk mode; harden the update failure log ([19c2be8](https://github.com/Ryuu3rs/AMR-Next/commit/19c2be83b5cd90f9ed2c1972adac646d3caf64ef))


### Bug Fixes

* address bug-hunt findings in the update/crawl/status code ([f8b87cb](https://github.com/Ryuu3rs/AMR-Next/commit/f8b87cba3e40a474942a848cc1e8ffb6c8d52861))
* apply a waiting extension update instead of wedging on a long check ([39f1969](https://github.com/Ryuu3rs/AMR-Next/commit/39f1969bd827551d55b57bf718d33d1a1d20e4eb))
* bug-hunt findings - bulk-select data loss, first-track list, log input ([e53793a](https://github.com/Ryuu3rs/AMR-Next/commit/e53793abd7321839587f33308b2421dbc3207451))
* comix prev/next by addressing chapters via the number in the URL ([078e420](https://github.com/Ryuu3rs/AMR-Next/commit/078e420c2a8fed72d2679950ae5ce4ea999d8868))
* converge-hunt findings - armed-remove snapshot, capture re-crawl, bulk tag ([bd04b12](https://github.com/Ryuu3rs/AMR-Next/commit/bd04b126c63d6c9adfae7d7beecdba1f3f1c8f9d))
* drive unread indicators by chapter number, not chapter id ([b3fe822](https://github.com/Ryuu3rs/AMR-Next/commit/b3fe822cff1e9c8d31b8032321808fa93068e583))
* harden the update-safety and unread-indicator fixes per red-team ([606fec1](https://github.com/Ryuu3rs/AMR-Next/commit/606fec146ba83dac7f3802180b750d54279de8d4))
* library toolbar wraps instead of running off the page ([5ca4f55](https://github.com/Ryuu3rs/AMR-Next/commit/5ca4f558d18583b935cfa7d45330b279d170977d))
* marking a chapter read no longer opens a Webtoons tab crawl ([e06984d](https://github.com/Ryuu3rs/AMR-Next/commit/e06984d1d51a28256f0ce94ffd2791e0990580bb))
* proactively clear stale update-progress on startup and install ([e09a88f](https://github.com/Ryuu3rs/AMR-Next/commit/e09a88f01419138049b3b81e2c2b330faec7f4cc))
* round-3 bug-hunt - oneshot re-crawl, select-all delete scope, unicode ([6f527fa](https://github.com/Ryuu3rs/AMR-Next/commit/6f527fa7708057d36ac05349bf108dbfc75770b4))
* stop the Webtoons reader tab-crawl reopening on every live event ([1b0cec1](https://github.com/Ryuu3rs/AMR-Next/commit/1b0cec1fcd04f8a98ac7973320ed0e985164a8e0))

## [0.13.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.12.0...v0.13.0) (2026-07-21)


### Features

* automated source-health tool (npm run health:sources) ([46cae88](https://github.com/Ryuu3rs/AMR-Next/commit/46cae88efdcade900ecfb983c7694c69d1c19f4f))
* repair fallback-tracked library entries, add backup-restore UI ([291a9ac](https://github.com/Ryuu3rs/AMR-Next/commit/291a9acfa8f29ffc006192c98a41e0686ec293a0))


### Bug Fixes

* 3 live-verified weebcentral bugs (chapters, series link, search) ([148f368](https://github.com/Ryuu3rs/AMR-Next/commit/148f36835ad0813eeeae8a789f5dae8871ef6b2e))
* 3 missing publishLive calls left open tabs silently stale ([6be770e](https://github.com/Ryuu3rs/AMR-Next/commit/6be770e1872c3bec6ec0501d5b3318280010bffe))
* 5 UI state bugs in the cleanup/backup Data-section tools ([c4e2e8d](https://github.com/Ryuu3rs/AMR-Next/commit/c4e2e8d607f19983a4217fd49e575b809a60318a))
* align reading stats to local days and reconcile re-resolved downloads ([b4ffe39](https://github.com/Ryuu3rs/AMR-Next/commit/b4ffe3917590249869730c5ff76b809d52b90f55))
* asurascans search endpoint dropped by /comics 301 to /browse ([6294140](https://github.com/Ryuu3rs/AMR-Next/commit/62941407490cdd240216afc68a5a578f65420aaa))
* bulkRemove/bulkManual left stale UI state on partial failure ([d29dc14](https://github.com/Ryuu3rs/AMR-Next/commit/d29dc14c6cc19b7bf0e4e09420a1d720e28a39ce))
* chapter-cache latestChapterNumber gate missed genuine Chapter 0 ([a798c94](https://github.com/Ryuu3rs/AMR-Next/commit/a798c948d188c931450812bb05aa97675fcc621b))
* correct mgeko search, mangafreak title, madara chapter order ([c206fda](https://github.com/Ryuu3rs/AMR-Next/commit/c206fda52ecbd6e6729123978ac084b280b47bdb))
* kagane manual-switch tab fallback, admit unknown-count exact matches ([544a843](https://github.com/Ryuu3rs/AMR-Next/commit/544a843ca46a1a47e33d6dc6f733f07d24d6f553))
* kagane stub-chapter sortKey no longer sorts before Chapter 1 ([521aef2](https://github.com/Ryuu3rs/AMR-Next/commit/521aef212d970595af3ba54cbb6972c1cc542e79))
* madara chapter list sortKey-0 fallback for unparseable titles ([1cef980](https://github.com/Ryuu3rs/AMR-Next/commit/1cef980d239bade871f7ccabb973948dd5857ab0))
* madara title-split regex, dynasty-scans bonus-chapter sort order ([801838b](https://github.com/Ryuu3rs/AMR-Next/commit/801838bc1a8552f8c9c0015f8c5b35a0527ac1e1))
* make the v8 cover migration Firefox-safe against upgrade data loss ([31e7e05](https://github.com/Ryuu3rs/AMR-Next/commit/31e7e0512d228dc235e45089a926ad3a1608b3ea))
* malformed [--|] title-split regex in mangabuddy and mangastream ([539bb52](https://github.com/Ryuu3rs/AMR-Next/commit/539bb52fb0a75490ca395a084b3b8e4403d7b464))
* mangafreak search endpoint and result-parsing bug ([dc95569](https://github.com/Ryuu3rs/AMR-Next/commit/dc955698f1b9b0ce0dd763528f9e20065a5694dc))
* mangahub badge showing millions of unread chapters ([7fec15f](https://github.com/Ryuu3rs/AMR-Next/commit/7fec15f1c102e295b7f536c27a204a341f3dc428))
* mgeko.cc URL scheme migration from /comic/ to /manga/ ([8b32e53](https://github.com/Ryuu3rs/AMR-Next/commit/8b32e530660f51575a05d0f8f8dc46d75a100383))
* olympustaff search dead due to relative-only href regex ([eb532ef](https://github.com/Ryuu3rs/AMR-Next/commit/eb532efd4fdd34c27e6d4d476821900fb7ca26a2))
* reader:resolve missing publishLive, last of the sibling handlers ([85f480a](https://github.com/Ryuu3rs/AMR-Next/commit/85f480aa7d4073933351d153ab0b958088918f39))
* retire 6 dead source domains; fix fanfox chapter list + age gate ([9ad0c87](https://github.com/Ryuu3rs/AMR-Next/commit/9ad0c87b8b842660c8146390037de5498c0ef8f0))
* retire dead asuracomic adapter, harden mangahub slug matching ([47443ed](https://github.com/Ryuu3rs/AMR-Next/commit/47443edf4b20ae505aeeda7792e1e1bed4ab882b))
* retire dead likemanga adapter, duplicate of mgread ([24f5eec](https://github.com/Ryuu3rs/AMR-Next/commit/24f5eecf02b96111f0efd89b981525239f2110c3))
* stale cleanup Undo banner surviving a manual backup restore ([5dcd7ad](https://github.com/Ryuu3rs/AMR-Next/commit/5dcd7addab4f743ddfb3b714b1becb2aff843e59))
* stop UNNUMBERED_SORT_KEY sentinel leaking into chapter selection ([989b371](https://github.com/Ryuu3rs/AMR-Next/commit/989b3714156c8126c383d847dc08e39f50647e78))
* stop Webtoons reader Next reopening a background tab endlessly ([f8a0f7e](https://github.com/Ryuu3rs/AMR-Next/commit/f8a0f7e3e7b06f2eac2b8a953c961800f1e346ec))
* trackExternalChapter sortKey-0 fallback clobbered reading progress ([7178267](https://github.com/Ryuu3rs/AMR-Next/commit/717826767a5f4057e851694a8dbec6a0840f4f8b))
* weebcentral chapter title leaking style/time markup ([a05f6a3](https://github.com/Ryuu3rs/AMR-Next/commit/a05f6a3eef8f8875e359540777fee5ce62684fb4))
* weebcentral search titles contaminated with "Official" ribbon text ([949c0df](https://github.com/Ryuu3rs/AMR-Next/commit/949c0dff55f1f9f40f1e2eb38df9c5a4fdffbdf0))
* wrap 5 multi-step Dexie writes in transactions, close 2 resurrection races ([0eda2b1](https://github.com/Ryuu3rs/AMR-Next/commit/0eda2b1ac0f2f890be6e83d5bcc7d229aa5b3c9b))
* wrap chapter-cache.ts multi-step writes in transactions ([fad904d](https://github.com/Ryuu3rs/AMR-Next/commit/fad904d5714b445243c58f3905d5ad7a43ea7ee8))

## [0.12.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.11.0...v0.12.0) (2026-07-17)


### Features

* cross-surface live-update bus, silent dashboard refresh ([280008e](https://github.com/Ryuu3rs/AMR-Next/commit/280008e03f62b63622509a3a3c61de46dd32aa02))
* reconcile debug-log export (copy + JSON download) ([1afc9f4](https://github.com/Ryuu3rs/AMR-Next/commit/1afc9f4c2e2298207e702176399bc6508ef2ed5b))


### Bug Fixes

* atomic library:merge handler, closes historyEvents data loss on duplicate merge ([e3dcb9e](https://github.com/Ryuu3rs/AMR-Next/commit/e3dcb9ed91f7b66f288b9f1f1605b4c21998772f))
* audit-driven correctness fixes across UI, background, and adapters ([f73dacb](https://github.com/Ryuu3rs/AMR-Next/commit/f73dacb5c5821239ec8bcbdeb9596fc5c08a50fb))
* auto-link retries next candidate instead of giving up, cleans (Official) markers ([b572148](https://github.com/Ryuu3rs/AMR-Next/commit/b5721485708949da025619377c18b7c89a364e6e))
* cooldown-gate background chapter-list refreshes ([a2a8d97](https://github.com/Ryuu3rs/AMR-Next/commit/a2a8d97e7e5e58c54948ebd33a5f6d0be2a2b91b))
* CORS/source-registry hardening — durable image-CDN grant pattern, templescan/manhuaplus retired, mangahub search-result chapter number ([3dd53c6](https://github.com/Ryuu3rs/AMR-Next/commit/3dd53c61419858c539cd6828d2263d56a44c2ac1))
* cover object URL doesn't refresh when the cached blob changes ([cb27f71](https://github.com/Ryuu3rs/AMR-Next/commit/cb27f717eb81a2022066941a366ac8fb1334980e))
* cross-source chapter numbers no longer max in merge, update-check no longer false-reports on repoint ([5309ec1](https://github.com/Ryuu3rs/AMR-Next/commit/5309ec10da54f06f4275ad5baa73e55b8f9ece5c))
* import/export data-safety hardening — chapters schema gap, missing bookmarks, partial-success import, pre-import backups ([a872bdc](https://github.com/Ryuu3rs/AMR-Next/commit/a872bdc52d520a4bf3f4a23b5e4f6c62b2df5754))
* mangaread and mangafreak sources completely dead behind origin filter ([412c987](https://github.com/Ryuu3rs/AMR-Next/commit/412c987f30c25e0d129d50e6b43779fc8ba17729))
* progress-completion ratchet, merge chapter-id carry, orphaned covers ([c21b0a6](https://github.com/Ryuu3rs/AMR-Next/commit/c21b0a66b72d649e2a1c54f846b0425f7500e47c))
* reader missing next-chapter controls, slow back-to-dashboard navigation ([e908631](https://github.com/Ryuu3rs/AMR-Next/commit/e908631c5764257eda590523a335535d82786ac9))
* reconcile UI leaking raw network errors, near-duplicate candidate rows ([37cbb4b](https://github.com/Ryuu3rs/AMR-Next/commit/37cbb4bbc623359b5f86f9d82d8a531dd05c847b))
* rename release-please concurrency group to clear a stuck lock ([27a6f17](https://github.com/Ryuu3rs/AMR-Next/commit/27a6f17bf4259d657ee47c2099038b14b903e37d))
* source-registry retirements, madara AJAX modernization, reader nav race, chapter-count pagination, shared entity decoder ([24ecad1](https://github.com/Ryuu3rs/AMR-Next/commit/24ecad15aee64df321ca226db666c957fba0fedd))
* update-check can get stuck at 'running' forever if the browser closes mid-check ([f3b0118](https://github.com/Ryuu3rs/AMR-Next/commit/f3b0118e824cf8be6cf5fad11884c47ed84e741d))
* update-check messaging bug + progress bar, reconcile UX, lossless duplicate merge ([9bccad2](https://github.com/Ryuu3rs/AMR-Next/commit/9bccad2ec2a30bc5f5f6d29aeeb764ce373725ce))
* use PAT for release-please so its pushes trigger CI ([9c7aaec](https://github.com/Ryuu3rs/AMR-Next/commit/9c7aaec4ad672d48b69aa457efee5955e30d827f))


### Performance Improvements

* chapter:adjacent cache-first, network only when stale ([8ee4398](https://github.com/Ryuu3rs/AMR-Next/commit/8ee43983d05ce6cd7acc402e2348cab81f6034b7))
* cover backfill runs cross-source concurrently, adds targeted single-title path ([6fc51b2](https://github.com/Ryuu3rs/AMR-Next/commit/6fc51b23e82802a5ac2381d19dce5642947638e2))
* index-scoped lookup in trackExternalChapter capture-error fallback ([2c6d06a](https://github.com/Ryuu3rs/AMR-Next/commit/2c6d06a44ab5906ee030cc948b6082003f64086d))
* reconcile Search-all sweep ~4-5x faster ([4d2a8da](https://github.com/Ryuu3rs/AMR-Next/commit/4d2a8da5d4b0e25e36ce0abe5d6be4fc3d54bc2d))
* share source-sdk response cache across per-operation clients ([0d7a348](https://github.com/Ryuu3rs/AMR-Next/commit/0d7a3481992f5c4d3501f8a0e3b2cf505f3b0ded))
* single-pass sourceTitleCounts, indexed library search ([60fb437](https://github.com/Ryuu3rs/AMR-Next/commit/60fb4373425c082696c637823fbb8316e5e46266))
* stop inlining covers as base64 data URIs, index chapters.url ([97bf4c2](https://github.com/Ryuu3rs/AMR-Next/commit/97bf4c2f98842a1fa2733d7c4400ffafadf64511))
* throttle reader progress reports to 1s trailing ([3a6c7d2](https://github.com/Ryuu3rs/AMR-Next/commit/3a6c7d2feab80837ec463df634d96d7e48daa6ab))

## [0.11.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.10.1...v0.11.0) (2026-07-14)


### Features

* add kagane.to source adaptor ([8ffa658](https://github.com/Ryuu3rs/AMR-Next/commit/8ffa658eb237da80e9e7659cc64fc26e44819854))


### Bug Fixes

* add missing playwright devDependency to browser-tests/runner ([8e7156b](https://github.com/Ryuu3rs/AMR-Next/commit/8e7156b56166355b513376b579014437ef5d354e))
* strip Svelte 5 $state proxies before sending import envelope over runtime messaging ([58db24c](https://github.com/Ryuu3rs/AMR-Next/commit/58db24c2fdc5b4eb44cf3739a6c361a814924234))
* tab-injection bot-block fallback captured the Cloudflare challenge page, not the real content ([e69d003](https://github.com/Ryuu3rs/AMR-Next/commit/e69d003139ef8b490de94b23833bb2a7d1b3d8ad))

## [0.10.1](https://github.com/Ryuu3rs/AMR-Next/compare/v0.10.0...v0.10.1) (2026-07-12)


### Bug Fixes

* manifest-policy test didn't detect VITE_COMMUNITY_API_ORIGIN when set as a build env var ([30ffb11](https://github.com/Ryuu3rs/AMR-Next/commit/30ffb11e2b67afa969730dc3655c2ed395934733))

## [0.10.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.9.10...v0.10.0) (2026-07-12)


### Features

* per-series webtoon view toggle, saved indicators, fix update-schedule dropdown ([5323f7d](https://github.com/Ryuu3rs/AMR-Next/commit/5323f7de5f522db99bcda713d5e1326dbeeb478a))


### Bug Fixes

* App.svelte UX polish — NSFW blur in Library, search grouping, filters, discoverability ([111ac20](https://github.com/Ryuu3rs/AMR-Next/commit/111ac20bc2ef7054605398d325c60eb54682059d))
* audit-driven correctness fixes across UI, background, and adapters ([e30e97d](https://github.com/Ryuu3rs/AMR-Next/commit/e30e97d94931699f7db7de7d5aaf8d7e288b21e0))
* cover-loading reliability — mangafreak real extraction, madara lazy-load attribute order, mangahub resolveCover ([17ec8ee](https://github.com/Ryuu3rs/AMR-Next/commit/17ec8ee8344fa3c6f9d8ff5991ae591fe0655515))
* export/import schema missing onHold, readingDirection, pageFit ([6e687c0](https://github.com/Ryuu3rs/AMR-Next/commit/6e687c0cec2bae719a74abe76c91599e237e2bf3))
* flaky checkUpdates concurrency test — poll for mock call instead of fixed tick ([dba1700](https://github.com/Ryuu3rs/AMR-Next/commit/dba1700e16a4cfdea28e85b718b13da4ef498d67))
* prefer-const lint error in community sync test, drop dead eslint-disable directives ([68367cf](https://github.com/Ryuu3rs/AMR-Next/commit/68367cf2a6f1cd2f5610f6c463819a665df333b4))
* reader bookmark reactivity, chapter counter, CBZ export, community auto-register, tighter search, source health accuracy ([9f5dcac](https://github.com/Ryuu3rs/AMR-Next/commit/9f5dcacfff995f55f40bdbf7eb656bb0bc003b81))
* repair release-please state and harden the release pipeline ([c007be6](https://github.com/Ryuu3rs/AMR-Next/commit/c007be661915edc208d52b0ba708691a3fa4807a))
* retire arvenscans, arvencomics, suryatoon — all confirmed dead ([339b6db](https://github.com/Ryuu3rs/AMR-Next/commit/339b6db3c89159ffd40ceffb84a633b45e91ad43))
* suppress zod eval-probe CSP violation in MV3 background context ([4c45284](https://github.com/Ryuu3rs/AMR-Next/commit/4c452848fd4920d71639963a90da760791700a88))
* unblock CI — 6 pre-existing typecheck errors + 2 stale test assertions ([44e9aab](https://github.com/Ryuu3rs/AMR-Next/commit/44e9aab979e9c888a98698473e741e3f478c37b8))
* Webtoons covers + tracking, reader header collapse, mangahub search, alt-title search, UX polish ([ee5defa](https://github.com/Ryuu3rs/AMR-Next/commit/ee5defa93ea3442afe3fc8b9215270eb8169d838))

## [0.9.1](https://github.com/Ryuu3rs/AMR-Next/compare/v0.9.0...v0.9.1) (2026-07-04)


### Bug Fixes

* 3 migration bugs — mangadex alias, manual URL form, import read progress ([a9c0eb9](https://github.com/Ryuu3rs/AMR-Next/commit/a9c0eb92c2924726d19a2df565f45bfeb0b6768b))
* sync package-lock.json with community-server workspace ([fa4ad70](https://github.com/Ryuu3rs/AMR-Next/commit/fa4ad704e79192ff22feacfa4f896eaad790dd7d))

## [0.9.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.8.3...v0.9.0) (2026-07-03)


### Features

* add 5 Madara sources, fix legacy import aliases, cap search timeout at 6s ([9ca1c1c](https://github.com/Ryuu3rs/AMR-Next/commit/9ca1c1cf64e72952d20ec16363a973a5b15af865))
* add capabilities override to MadaraConfig, re-enable ManhuaTop as sidebar-only ([0ff96d8](https://github.com/Ryuu3rs/AMR-Next/commit/0ff96d8ed733083bcb6c6e7952ffafe314a6afb4))
* add MangaFreak (full reader) and Comix.to (sidebar/tracking) source adapters ([3a4c6b4](https://github.com/Ryuu3rs/AMR-Next/commit/3a4c6b4d7816f2ad18f0350df60e6e17e90d9850))
* add MgRead (mgread.io) as Madara source ([1d487eb](https://github.com/Ryuu3rs/AMR-Next/commit/1d487ebe7edf179aa03b1b94d709ba6fb4e025a9))
* stream search results per-source as each adapter settles ([6147ace](https://github.com/Ryuu3rs/AMR-Next/commit/6147ace7e5eba283cd699dcbeda65552d0d7eb48))


### Bug Fixes

* 3 bugs — delay on failed updates, mangafreak CDN fallback, madara capability guard ([2504234](https://github.com/Ryuu3rs/AMR-Next/commit/25042345391526123a7fa5ab2e364f36952b0d69))
* 6 bugs + retire 12 dead sources + add retirement workflow doc ([d909404](https://github.com/Ryuu3rs/AMR-Next/commit/d9094047cd1c4d377ff84549863a5c140bb0815b))
* allow library:switch with 0 chapters for sidebar-only sources ([3cf0f43](https://github.com/Ryuu3rs/AMR-Next/commit/3cf0f43b916e10aaae0b27a58bd9fbd8d150f0f0))
* bump Firefox strict_min_version to 142 for data_collection_permissions support, add sign:firefox script ([97f4b72](https://github.com/Ryuu3rs/AMR-Next/commit/97f4b72ed6d37090b550f15b624a42da2a3c3ddb))
* change gecko ID to all-mangas-reader-2@ryuu3rs.dev (original ID taken on AMO) ([ef057ca](https://github.com/Ryuu3rs/AMR-Next/commit/ef057ca398b85f1c33cc787adf1a4f99602f5693))
* clear import banner on resolve, add Find Better Sources bulk scan, fix update rate limiting ([c2be80b](https://github.com/Ryuu3rs/AMR-Next/commit/c2be80ba23d23c0f64223ba4e024b8fef2ff16c6))
* community stats not showing after registration — fetch leaderboard even with no new chapters, add Sync Now button, refresh profile post-register ([9d6fedd](https://github.com/Ryuu3rs/AMR-Next/commit/9d6fedda702235b4f809828e7ada4f2b0dde0a99))
* eliminate Function() and innerHTML from AMO-submitted bundle ([765c252](https://github.com/Ryuu3rs/AMR-Next/commit/765c2529bed5985d3b02d84a1de045bbd6221892))
* set mangaPath=series for VortexScans (uses /series/ not /manga/) ([948ec22](https://github.com/Ryuu3rs/AMR-Next/commit/948ec22ae259c5f33c0737c914859c8bacbba618))
* update gecko ID to amr-next@ryuu3rs.dev ([3bd8e97](https://github.com/Ryuu3rs/AMR-Next/commit/3bd8e97703f3f85aaeb5694cfbd96a3e501cd269))

## [0.8.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.7.1...v0.8.0) (2026-06-28)


### Features

* add clear library and clear history options to Settings ([5a07831](https://github.com/Ryuu3rs/AMR-Next/commit/5a07831d9898f7ab4f8255c6d4100d7c9db3395d))
* add MangaHub adapter with on-page panel support ([f8421b2](https://github.com/Ryuu3rs/AMR-Next/commit/f8421b2959c761b5c8e0d0250c2f481d3e6acb9d))
* add Tritinia Scans, fix reconcile SW timeout, add search-all ([72fafa3](https://github.com/Ryuu3rs/AMR-Next/commit/72fafa3bc6c1e5a39f3680c84a2b1baa7f140c81))
* add WEBTOON adapter and fix legacy import for 92 webtoon titles ([b741c68](https://github.com/Ryuu3rs/AMR-Next/commit/b741c6814c589d2367a7cb194799203d8afd7734))
* history clickable rows, reader chapter dropdown, bug fixes ([abc49c0](https://github.com/Ryuu3rs/AMR-Next/commit/abc49c037e4728c25e0f90116011627e2b859736))
* import reconcile progress bar, 3x concurrency, auto-link, stop button ([197472f](https://github.com/Ryuu3rs/AMR-Next/commit/197472f9fae44aeaf132980773b113be44b14f7d))
* updates page grouped accordion with nested chapters ([966eb07](https://github.com/Ryuu3rs/AMR-Next/commit/966eb07dd99d3572c298da8dac5bfe0135ff3847))


### Bug Fixes

* add root route to community API ([7a3fc9f](https://github.com/Ryuu3rs/AMR-Next/commit/7a3fc9f021864b08311abb7cc59c8e00a726b7ad))
* import conflict dialog shows error inline and stays visible during processing; add genres to export schema ([412bf97](https://github.com/Ryuu3rs/AMR-Next/commit/412bf9791c9acc170685b238a95991e39eaa55d5))
* map legacy AMR domain aliases in import so old library entries resolve correctly ([acf492c](https://github.com/Ryuu3rs/AMR-Next/commit/acf492cfcd0102d18fafee724baaa883e8471c42))
* reconcile title matching uses word-overlap for alternate translations ([5351bc4](https://github.com/Ryuu3rs/AMR-Next/commit/5351bc406af26afaccb37551390d2d2d597b1636))
* tabs.onUpdated URL filter Chrome-only (Firefox supports it, Chrome does not) ([6980bc3](https://github.com/Ryuu3rs/AMR-Next/commit/6980bc380af5a39a04f393fa0c9f6d3b8a450c9c))
* webtoons chapter images via tab render and pstatic.net referer rule ([24c67d6](https://github.com/Ryuu3rs/AMR-Next/commit/24c67d699148ca170ed40cfa6999caeafd4c80a6))

## [0.6.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.5.0...v0.6.0) (2026-06-18)


### Features

* add Dynasty Scans adapter and fix reader image fallback ([e17daea](https://github.com/Ryuu3rs/AMR-Next/commit/e17daea57cf57108c4bc677b4e0cdb4db8790899))
* add ephemeral New/Updated badges to library cards (24h auto-expire) ([a7cccaa](https://github.com/Ryuu3rs/AMR-Next/commit/a7cccaa684f32010ffb5882d1d1d30e49470bcbd))
* add mangabuddy.com to buddy source adapter registry ([a0b764e](https://github.com/Ryuu3rs/AMR-Next/commit/a0b764e92b0b0d6e92c11d274c036b3ae1692bc1))
* add MangaNato adapter and Madara config rows for user import sources ([128e695](https://github.com/Ryuu3rs/AMR-Next/commit/128e6955656da77476af9991f8f34011fe8fabb4))
* add MangaPark source adapter (mangapark.net) ([5644be6](https://github.com/Ryuu3rs/AMR-Next/commit/5644be6f633ad8a05e0747701672619aeee32f6c))
* add Weeb Central adapter with ULID-based series/chapter routing ([506a96e](https://github.com/Ryuu3rs/AMR-Next/commit/506a96e7d3a73241ea1bdecdff3c50ec25eac286))
* cache cover images in IndexedDB to avoid repeated network fetches ([66370ea](https://github.com/Ryuu3rs/AMR-Next/commit/66370eafd4fc4f620c92dd9897eb11cec8d83741))
* in-extension update check banner and fix raw fetch in getMangaChapters ([509863f](https://github.com/Ryuu3rs/AMR-Next/commit/509863f5ed312bb3d3441fa07fdbb67896f9d4d5))
* migrate old AMR export format on import ([3071b43](https://github.com/Ryuu3rs/AMR-Next/commit/3071b431990f92ce8875a568950ed18028baf568))
* move all source origins to required host_permissions — no manual grant needed ([eca6ac6](https://github.com/Ryuu3rs/AMR-Next/commit/eca6ac64c20d5d707c2bf2f5342e650446c09def))
* post-import reconciliation for dead sources ([d2b934d](https://github.com/Ryuu3rs/AMR-Next/commit/d2b934d2c7cc9f09b10c40f7c6f5487fa635a9e2))
* support legacy imports with optional tables ([f75f0f9](https://github.com/Ryuu3rs/AMR-Next/commit/f75f0f91ff71563cb2c052e30bfd11d8dfaabc0a))
* tab injection fallback for bot-blocked chapter fetches (403/502/503) ([5bb67a6](https://github.com/Ryuu3rs/AMR-Next/commit/5bb67a6bec8748dcc477e97882032aaec11d4f94))
* unify poster menu to detail modal and add manual tracking controls ([3dc72f9](https://github.com/Ryuu3rs/AMR-Next/commit/3dc72f9523d920f52990b7e4d9824a928cd6ef22))


### Bug Fixes

* dynasty-scans image key is 'image' not 'url', decode &raquo; and other named entities ([e2a024d](https://github.com/Ryuu3rs/AMR-Next/commit/e2a024dee42718d8c6efbea9b417ce86edd9caa4))
* include URL in unsupported-chapter error and relax madara trailing-slash ([f69f890](https://github.com/Ryuu3rs/AMR-Next/commit/f69f890003af5de29406b692036ee841d0ddc3df))
* loop cover backfill until all missing covers are processed ([dbd1930](https://github.com/Ryuu3rs/AMR-Next/commit/dbd19307e0bbf1f827a92c644ce97af9d9a0fff1))
* mangaread.org chapter images missing — ?style=list and src-first attr priority ([006420b](https://github.com/Ryuu3rs/AMR-Next/commit/006420b4f482e3c35a0e2cae657c648ad1c18b27))
* move poster menu panel outside overflow:hidden wrap so it renders over the card ([6b5d811](https://github.com/Ryuu3rs/AMR-Next/commit/6b5d811d4ebdc50150f9064bc518c9fe8acde91c))
* paginate reconcile panel and auto-backfill covers after import ([8360807](https://github.com/Ryuu3rs/AMR-Next/commit/83608074339916776d867225d6784c6b4c24579c))
* remove leftover poster-confirm dead block after menu unification ([4eaf9cd](https://github.com/Ryuu3rs/AMR-Next/commit/4eaf9cd37b029ca2d1a7fbfcaf90fefca30cc368))
* rework detail modal layout — fix cover stretch, compact options, section dividers ([d619418](https://github.com/Ryuu3rs/AMR-Next/commit/d6194185758badb957c27676a6360231f281c503))
* **sources:** use centralized SOURCE_ORIGINS instead of hardcoding ([efe9ce5](https://github.com/Ryuu3rs/AMR-Next/commit/efe9ce5f1f04735e96ae12250e9409540397b6d1))
* state_unsafe_mutation in ImportReconcile and CSP eval from modulepreload polyfill ([999152a](https://github.com/Ryuu3rs/AMR-Next/commit/999152a9e031e88a8e0ceea1fe92b81f9f76af83))
* trim whitespace from img attribute values in madara extractor ([eafe938](https://github.com/Ryuu3rs/AMR-Next/commit/eafe938e6de72a9146d12fae2ae1edfe197438d4))
* use credentials omit for cross-origin fetches to avoid Firefox CORS enforcement ([d286c7a](https://github.com/Ryuu3rs/AMR-Next/commit/d286c7af49c10b3881cf04dd1c3584aca82517af))
* use https:// prefix for dynasty-scans origins so bounded request client allows fetches ([d877063](https://github.com/Ryuu3rs/AMR-Next/commit/d877063af0fd78651905c3ab43495b88146a7b31))
* wildcard origins crash request client and cover backfill loops forever ([b7fb093](https://github.com/Ryuu3rs/AMR-Next/commit/b7fb09376b1656cfb287eea0305dd62af054baf8))

## [0.5.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.4.0...v0.5.0) (2026-06-16)


### Features

* auto-add/track any opened chapter + cache covers as data URLs ([#54](https://github.com/Ryuu3rs/AMR-Next/issues/54)) ([50ecee6](https://github.com/Ryuu3rs/AMR-Next/commit/50ecee6d5a5cd768f985706b3c14bd771e430f79))
* library list view, grouped history + 6 features ([#55](https://github.com/Ryuu3rs/AMR-Next/issues/55)) ([e43c6ce](https://github.com/Ryuu3rs/AMR-Next/commit/e43c6ce8f1946641f22ec8963143c5e4646dac0c))
* **library:** NSFW flag with cover blur (F4) ([#38](https://github.com/Ryuu3rs/AMR-Next/issues/38)) ([c4d71bb](https://github.com/Ryuu3rs/AMR-Next/commit/c4d71bb1d1d21f3e55fc8a48891669b4e4eabdee))
* manga tags with source suggestions, tag manager, palette + more ([#56](https://github.com/Ryuu3rs/AMR-Next/issues/56)) ([5ec459f](https://github.com/Ryuu3rs/AMR-Next/commit/5ec459f405c90db872b61a5c7e511fbeb281f9d9))
* **mobile:** responsive layout for phones + Android docs (G14) ([#43](https://github.com/Ryuu3rs/AMR-Next/issues/43)) ([e8b889a](https://github.com/Ryuu3rs/AMR-Next/commit/e8b889ac49d3a4b3c2a9eb5e5b7687bdafd4e6f0))
* **reader:** keyboard-shortcut help overlay (E2) ([#47](https://github.com/Ryuu3rs/AMR-Next/issues/47)) ([5fa2182](https://github.com/Ryuu3rs/AMR-Next/commit/5fa21827ce8fb56c2c156bae48561f2c37f138f7))
* **reader:** offline chapter downloads (A9) ([#44](https://github.com/Ryuu3rs/AMR-Next/issues/44)) ([f502bd8](https://github.com/Ryuu3rs/AMR-Next/commit/f502bd8d34e8de18d88ecab39ac5ca1aeae8bf6a))
* **reader:** prev/next chapter navigation + mark-read-and-next (A7, A8) ([#36](https://github.com/Ryuu3rs/AMR-Next/issues/36)) ([9d2bc62](https://github.com/Ryuu3rs/AMR-Next/commit/9d2bc627121cfe963f6d12c9f9c4dd03f29adfc1))
* **reader:** read-on-site fallback that still tracks progress ([#53](https://github.com/Ryuu3rs/AMR-Next/issues/53)) ([f62ace8](https://github.com/Ryuu3rs/AMR-Next/commit/f62ace8357a5b2a463d1ee800d442fd1f62b505f))
* **reader:** remember reading mode per title (A10) ([#41](https://github.com/Ryuu3rs/AMR-Next/issues/41)) ([df1f0a0](https://github.com/Ryuu3rs/AMR-Next/commit/df1f0a0c58a3c6800060066dd129d6601456133a))
* **reader:** zoom + fullscreen + immersive mode (A5, A6) ([#40](https://github.com/Ryuu3rs/AMR-Next/issues/40)) ([4c70f49](https://github.com/Ryuu3rs/AMR-Next/commit/4c70f496a79f6b91d521b7e4b8ac9004ff5c060f))
* **sources:** 5 more probe-green sites as config rows ([#48](https://github.com/Ryuu3rs/AMR-Next/issues/48)) ([c227744](https://github.com/Ryuu3rs/AMR-Next/commit/c227744e98ff242ad8f74d71e758a33bd494e6a9))
* **sources:** MangaBuddy adapter (2 sites) + multi-language preference (C3, C6) ([#42](https://github.com/Ryuu3rs/AMR-Next/issues/42)) ([399e69e](https://github.com/Ryuu3rs/AMR-Next/commit/399e69e9ed863f4e079a8cb6284cd8783aa966f7))
* **stats:** data-driven achievements (B7) ([#49](https://github.com/Ryuu3rs/AMR-Next/issues/49)) ([b80e38b](https://github.com/Ryuu3rs/AMR-Next/commit/b80e38b6e3f51ca4f39a0e115cb8f9731136e572))
* **ux:** covers, global search, mirror fallback, download resiliency + UI polish ([#50](https://github.com/Ryuu3rs/AMR-Next/issues/50)) ([3fb2c4f](https://github.com/Ryuu3rs/AMR-Next/commit/3fb2c4ffc6b124fc4166798efa1274b871043b4b))


### Bug Fixes

* **popup:** detect all supported sources, drop stale copy ([#39](https://github.com/Ryuu3rs/AMR-Next/issues/39)) ([465e01b](https://github.com/Ryuu3rs/AMR-Next/commit/465e01b726dde282edc0b2021204e0d3233b02d3))
* **sources:** reject nav-junk in search + give sample data real covers ([#51](https://github.com/Ryuu3rs/AMR-Next/issues/51)) ([8570176](https://github.com/Ryuu3rs/AMR-Next/commit/857017601221936cb7efd03b94f16e55a08d8331))
* **ux:** bundle sample covers, move search to Home, source ping dots, drop Cypher Scans ([#52](https://github.com/Ryuu3rs/AMR-Next/issues/52)) ([4866193](https://github.com/Ryuu3rs/AMR-Next/commit/4866193312586a012a22a7fdcc9b9fee6c639dc1))


### Performance Improvements

* **source-sdk:** coalesce concurrent identical GET requests (D3) ([#45](https://github.com/Ryuu3rs/AMR-Next/issues/45)) ([f8d0d3b](https://github.com/Ryuu3rs/AMR-Next/commit/f8d0d3bb8423d30b8f7575ed9b26b3f4dd3bb1a0))

## [0.4.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.3.0...v0.4.0) (2026-06-15)


### Features

* **app:** add Ko-fi support section + Discord mention ([#30](https://github.com/Ryuu3rs/AMR-Next/issues/30)) ([5585ed1](https://github.com/Ryuu3rs/AMR-Next/commit/5585ed14d75bc52ad4181fef39b546f865863036))
* **app:** dark/light/system theme (E1) ([#29](https://github.com/Ryuu3rs/AMR-Next/issues/29)) ([d252de8](https://github.com/Ryuu3rs/AMR-Next/commit/d252de83cb5881b6cc513761b6e04007c3ec1e3e))
* **app:** first-run onboarding card (E3) ([#31](https://github.com/Ryuu3rs/AMR-Next/issues/31)) ([121af18](https://github.com/Ryuu3rs/AMR-Next/commit/121af18098e2a8fc4757f525dd2d3987798098bf))
* **library:** bulk actions via select mode (F5) ([#22](https://github.com/Ryuu3rs/AMR-Next/issues/22)) ([4b34637](https://github.com/Ryuu3rs/AMR-Next/commit/4b34637944f9fccc76eb1e902121698f7d964488))
* **library:** categories + filtering (B2 / G10) ([#20](https://github.com/Ryuu3rs/AMR-Next/issues/20)) ([038fb81](https://github.com/Ryuu3rs/AMR-Next/commit/038fb816d55c41fd74bb1a8892df24e998e6ec62))
* **library:** check a title across all supported mirrors (G17) ([#24](https://github.com/Ryuu3rs/AMR-Next/issues/24)) ([518160f](https://github.com/Ryuu3rs/AMR-Next/commit/518160f7b407ebee0cad61c0c72529a54d93b167))
* **library:** duplicate detection + merge (F3) ([#23](https://github.com/Ryuu3rs/AMR-Next/issues/23)) ([743d1db](https://github.com/Ryuu3rs/AMR-Next/commit/743d1dbe48c24ab3292461688303c84b6d99c0af))
* **library:** one-click switch to another mirror (G8) ([#27](https://github.com/Ryuu3rs/AMR-Next/issues/27)) ([96a23c4](https://github.com/Ryuu3rs/AMR-Next/commit/96a23c47ae0e1f19efad30f255e4494da3b0b66f))
* **library:** re-link a title to a new source/mirror (G3) ([#21](https://github.com/Ryuu3rs/AMR-Next/issues/21)) ([5f20c1c](https://github.com/Ryuu3rs/AMR-Next/commit/5f20c1cd66e8342d0c79a5a7a658ebfe59f88cd4))
* **sources:** generic MangaStream/ts-theme adapter + 6 sites ([#25](https://github.com/Ryuu3rs/AMR-Next/issues/25)) ([c3c12e2](https://github.com/Ryuu3rs/AMR-Next/commit/c3c12e2ec2aeddb4a6dc80073e889811299f86b3))
* **stats:** daily reading goal (B6) ([#35](https://github.com/Ryuu3rs/AMR-Next/issues/35)) ([b8a51f8](https://github.com/Ryuu3rs/AMR-Next/commit/b8a51f88a33847df5fe396d9b69a9e36bd1e7966))
* **stats:** reading streaks + this-week stats (B5) ([#32](https://github.com/Ryuu3rs/AMR-Next/issues/32)) ([87bc533](https://github.com/Ryuu3rs/AMR-Next/commit/87bc533966cdca956f1f0280c736008b63acb416))


### Bug Fixes

* **ci:** build before test in check script so manifest test finds .output ([3d4682e](https://github.com/Ryuu3rs/AMR-Next/commit/3d4682e44bd1f5636a03c2921aaedab328dc8c81))

## [0.3.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.2.0...v0.3.0) (2026-06-15)


### Features

* **library:** add star rating for manga ([#5](https://github.com/Ryuu3rs/AMR-Next/issues/5)) ([787a0b9](https://github.com/Ryuu3rs/AMR-Next/commit/787a0b921731552ddb601d365314784ba223e9e5))
* **library:** domain-independent chapter-number tracking ([#7](https://github.com/Ryuu3rs/AMR-Next/issues/7)) ([1e10796](https://github.com/Ryuu3rs/AMR-Next/commit/1e10796b14292702f4d9313cd5ddd3f1cc209a0c))
* **library:** manga detail view (B1) ([#18](https://github.com/Ryuu3rs/AMR-Next/issues/18)) ([08ffd14](https://github.com/Ryuu3rs/AMR-Next/commit/08ffd146227741b6c050819cf61d8cefcf04878b))
* **library:** manual / "Do Not Scan" titles with hand-set chapter numbers ([#11](https://github.com/Ryuu3rs/AMR-Next/issues/11)) ([7d82343](https://github.com/Ryuu3rs/AMR-Next/commit/7d823436e35f29e4c480f13af3957425a8be68f6))
* **library:** open-in-browser + ctrl-click + recently-added/read sort ([#8](https://github.com/Ryuu3rs/AMR-Next/issues/8)) ([0a54363](https://github.com/Ryuu3rs/AMR-Next/commit/0a543633d81c7f8fdac5cad264fa0a57b94802d1))
* **library:** reading history view (B4) ([#17](https://github.com/Ryuu3rs/AMR-Next/issues/17)) ([7a8f777](https://github.com/Ryuu3rs/AMR-Next/commit/7a8f777cbe77c0919c576c79c0fe977f7d51691a))
* **library:** reliable cover system with backfill and fallback ([#10](https://github.com/Ryuu3rs/AMR-Next/issues/10)) ([038b25b](https://github.com/Ryuu3rs/AMR-Next/commit/038b25bfbdca64b274f3bb51ea14cab195a0cbf7))
* **reader:** add reading direction, page fit, page number, and preload settings ([#4](https://github.com/Ryuu3rs/AMR-Next/issues/4)) ([0d39332](https://github.com/Ryuu3rs/AMR-Next/commit/0d3933211dbb665c24ca5d0e76a4ce84de60a8bb))
* **sources:** chapter listing for the Madara family (C2) ([#14](https://github.com/Ryuu3rs/AMR-Next/issues/14)) ([f2271dd](https://github.com/Ryuu3rs/AMR-Next/commit/f2271dddd60b018e116655a71fb163f33afd08e6))
* **sources:** config-driven generic Madara adapter (C3) ([#9](https://github.com/Ryuu3rs/AMR-Next/issues/9)) ([4fcca87](https://github.com/Ryuu3rs/AMR-Next/commit/4fcca87013f7f5c8a40ed6203961aa94d1964f21))
* **sources:** multi-source search with latest-chapter (C1 + G7) ([#13](https://github.com/Ryuu3rs/AMR-Next/issues/13)) ([841735f](https://github.com/Ryuu3rs/AMR-Next/commit/841735f80cb99f883ffde3c58151ed51d8934a0f))
* **sync:** GitHub Gist sync for the library backup ([#12](https://github.com/Ryuu3rs/AMR-Next/issues/12)) ([bb4ac6f](https://github.com/Ryuu3rs/AMR-Next/commit/bb4ac6fa03edd558a822c85b68656e18672d732a))
* **tooling:** mirror anti-scrape probe + tracking-integrity backlog ([#6](https://github.com/Ryuu3rs/AMR-Next/issues/6)) ([1966e56](https://github.com/Ryuu3rs/AMR-Next/commit/1966e568f8a0922670dba42673b55d921b596b6e))
* **updates:** per-source refresh (G4) ([#15](https://github.com/Ryuu3rs/AMR-Next/issues/15)) ([e6ead28](https://github.com/Ryuu3rs/AMR-Next/commit/e6ead2846dedc3927a37c883b8b972848e557871))
* **updates:** surface update failures + adapter diagnostics (I7, D5, D6) ([#16](https://github.com/Ryuu3rs/AMR-Next/issues/16)) ([a81ef4e](https://github.com/Ryuu3rs/AMR-Next/commit/a81ef4e68812bce9c1d95b3e2e369212d04ab65d))


### Bug Fixes

* **ci:** exclude release-please CHANGELOG from prettier check ([34bdf2e](https://github.com/Ryuu3rs/AMR-Next/commit/34bdf2e51f738bc78201b1edfea272f7e0beea02))
* **ci:** sync extension manifest version with release-please bumps ([ed1e93d](https://github.com/Ryuu3rs/AMR-Next/commit/ed1e93d0b4f490caca1dc695aa8c766e9fd3981a))

## [0.2.0](https://github.com/Ryuu3rs/AMR-Next/compare/v0.1.0...v0.2.0) (2026-06-14)


### Features

* cross-browser extension rewrite (WXT + Svelte) with source adapters, reliability, and release automation ([#1](https://github.com/Ryuu3rs/AMR-Next/issues/1)) ([624a636](https://github.com/Ryuu3rs/AMR-Next/commit/624a6367639ad27dbc3453e3f970bade36645966))
* **lab:** add BatchTester and MirrorDiagnostics for mirror testing (8d422ca)
* **mirrors:** add disabledForSearch flag to disable search-only (ded0b1d)
* **ui:** add MangaHealth component for site status checking (625372a)
* **v4.0.1:** Quick category button & notification click fix (7991514)
* **v4.0.3:** Add manga by URL feature for Cloudflare-protected sites (d490d27)
* **v4.0.4:** Add Weeb Central mirror (ced2a99)


### Bug Fixes

* app isn't fully initialized using firefox (6206bbc)
* calling map to undefined variable (95c2d57)
* can't enable gist without restarting browser (806b365)
* chapter list loading in reader and popup views (2399d0c)
* database persistence and Vue 3 Proxy serialization issues (aed45f2)
* database persistence, dashboard components, and infrastructure updates (2e0a2f7)
* image loading for MangaHere and protocol-relative URLs (a3a5dc0)
* **mirrors:** add null checks to base classes to prevent crashes (08b529f)
* **mirrors:** fix MangaBuddy variable name typo (fe642e7)
* UI components and debug logging improvements (f74bd4e)


### Performance Improvements

* **reader:** centralize scroll handling with throttled event broadcasting (eca7928)
* **reader:** implement quick performance wins for scan lookup and state saves (c17fe0c)
* **reader:** memoize thumbnails and gate debug logs (e8aa153)

## Changelog

## Unreleased

- Preserved the pre-clean rewrite workspace.
- Reorganized previous implementations under `archive/`.
- Added the WXT and Svelte extension workspace.
- Added shared contracts, source SDK, source registry, and fixture packages.
- Changed distribution planning to GitHub Releases.
