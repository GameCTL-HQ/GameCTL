// Curated mode + map catalog — the single source of truth for the GameCtlRtv
// plugin (two-stage !rtv) AND for GameModeManager's GameModes.List (driving
// !modes / !maps), so every interface shows the same modes.
//
// Generated from the kus cs2-modded-server image's own gamemodes_server.txt
// (captured 2026-05-22) — 32 native modes + GameCTL's Practice (free).
// The GameCTL generator also seeds subscribed_file_ids.txt from the workshop
// ids below so the kus image pre-downloads every map at boot.
//
// To rebuild: /tmp/gen_catalog.py reads gamemodes_server.txt off a live pod
// and emits this file. Map order within each mode mirrors the image's group
// order; per-mode list is capped to keep vote menus a reasonable size.

const ws = (name, id) => ({ name, id: String(id), workshop: true })
const stock = (name) => ({ name, id: name, workshop: false })

export const CS2_RTV_CATALOG = [
  {
    key: "armsrace", name: "Gun Game", cfg: "gg.cfg", mapGroup: "mg_gg",
    maps: [
      stock("ar_shoots"),
      stock("ar_shoots_night"),
      stock("ar_baggage"),
      stock("ar_pool_day"),
      ws("speedball", 3443206318),
      ws("aim_plywood", 3118710028),
      ws("gg_lego_arena", 3267768230),
      ws("de_indoor", 3535917558),
      ws("de_assembly", 3071005299),
      ws("fy_iceworld", 3070238628),
      ws("daymare", 3072640420),
      ws("mcdonalds", 3134466699),
      ws("aim_theorem", 3070348309),
      ws("de_safehouse", 3070550406),
      ws("de_lake", 3070563536),
    ],
  },
  {
    key: "deathmatch", name: "Deathmatch", cfg: "deathmatch.cfg", mapGroup: "mg_dm",
    maps: [
      stock("de_vertigo"),
      stock("de_dust2"),
      stock("de_inferno"),
      stock("de_mirage"),
    ],
  },
  {
    key: "competitive", name: "Competitive", cfg: "comp.cfg", mapGroup: "mg_comp",
    maps: [
      stock("de_dust2"),
      stock("de_cache"),
      stock("de_mirage"),
      stock("de_inferno"),
      stock("de_ancient_night"),
      stock("de_nuke"),
      stock("de_train"),
      stock("de_overpass"),
      stock("de_anubis"),
      stock("de_vertigo"),
      stock("de_warden"),
      stock("de_stronghold"),
      stock("cs_alpine"),
      stock("cs_office"),
      stock("cs_italy"),
      // Mini-scale workshop variants — same comp rules, shrunken
      // geometry. Operator unlocks team caps (mp_limitteams 0,
      // sv_visiblemaxplayers 32) when running these so 8v8 / 10v10
      // fits without "Team is full".
      ws("mini_mirage",     3084978100),
      ws("mini_dust2",      3441724363),
      ws("mini_dust",       3273786599),
      ws("mini_dust_pro",   3429868858),
      ws("mini_dust_piter", 3728197717),
      ws("mini_inferno",    3482557789),
      ws("mini_nuke",       3578594213),
      ws("mini_vertigo",    3317783114),
    ],
  },
  {
    key: "wingman", name: "Wingman", cfg: "wingman.cfg", mapGroup: "mg_wingman",
    maps: [
      stock("de_sanctum"),
      stock("de_cache"),
      stock("de_poseidon"),
      stock("de_overpass"),
      stock("de_vertigo"),
      stock("de_nuke"),
      stock("de_inferno"),
      stock("ar_pool_day"),
      ws("de_rooftop", 3536622725),
      ws("de_splat", 3439120481),
      ws("de_dust2_wingman", 3413800427),
      ws("de_mirage_d", 3402437047),
      ws("de_palais", 3257582863),
      ws("de_whistle", 3308613773),
      ws("gd_rialto", 3085490518),
    ],
  },
  {
    key: "practice", name: "FaceIT Practice", cfg: "prac.cfg", mapGroup: "mg_comp",
    maps: [
      stock("de_dust2"),
      stock("de_cache"),
      stock("de_mirage"),
      stock("de_inferno"),
      stock("de_ancient_night"),
      stock("de_nuke"),
      stock("de_train"),
      stock("de_overpass"),
      stock("de_anubis"),
      stock("de_vertigo"),
      stock("de_warden"),
      stock("de_stronghold"),
      stock("cs_alpine"),
      stock("cs_office"),
      stock("cs_italy"),
    ],
  },
  {
    key: "practice_free", name: "Free Practice", cfg: "prac_free.cfg", mapGroup: "mg_active",
    maps: [
      stock("de_ancient"),
      stock("de_anubis"),
      stock("de_inferno"),
      stock("de_mirage"),
      stock("de_nuke"),
      stock("de_dust2"),
      stock("de_overpass"),
    ],
  },
  {
    key: "prefire", name: "Prefire", cfg: "prefire.cfg", mapGroup: "mg_prefire",
    maps: [
      stock("de_ancient"),
      stock("de_anubis"),
      stock("de_inferno"),
      stock("de_mirage"),
      stock("de_nuke"),
      stock("de_dust2"),
      stock("de_train"),
      stock("de_overpass"),
      stock("de_vertigo"),
    ],
  },
  {
    key: "retake", name: "Retakes", cfg: "retake.cfg", mapGroup: "mg_retake",
    maps: [
      stock("de_ancient"),
      stock("de_anubis"),
      stock("de_inferno"),
      stock("de_mirage"),
      stock("de_nuke"),
      stock("de_dust2"),
      stock("de_train"),
      stock("de_overpass"),
      stock("de_vertigo"),
    ],
  },
  {
    key: "executes", name: "Executes", cfg: "executes.cfg", mapGroup: "mg_executes",
    maps: [
      stock("de_mirage"),
    ],
  },
  {
    key: "awp", name: "Awp Only", cfg: "awp.cfg", mapGroup: "mg_awp",
    maps: [
      ws("awp_bhop_rocket", 3142070597),
      ws("bump_arena", 3679420050),
    ],
  },
  {
    key: "arena1v1", name: "1v1 Arenas", cfg: "1v1.cfg", mapGroup: "mg_1v1",
    maps: [
      ws("aim_redline_fp", 3070253400),
    ],
  },
  {
    key: "aim", name: "Aim", cfg: "aim.cfg", mapGroup: "mg_aim",
    maps: [
      ws("aim_map", 3084291314),
      ws("gg_festspeedball", 3111527644),
      ws("aim_plywood", 3118710028),
      ws("freebet_aim_map", 3146122036),
      stock("ar_pool_day"),
      ws("aim_ak-colt_CS2", 3078701726),
      ws("aim_usp", 3085962528),
      ws("aim_deagle", 3075996446),
      ws("1v1aim_map_longdustversion_d", 3082605693),
      ws("de_splat", 3439120481),
      ws("1v1v1v1beta04", 3433012420),
      ws("ar_blue_arena", 3361478861),
      ws("gg_strafe_gg1", 3331570055),
      ws("aim_shotty2_gg1", 3360120483),
      ws("fy_hangemhigh", 3437226954),
    ],
  },
  {
    key: "bhop", name: "Bhop", cfg: "bhop.cfg", mapGroup: "mg_bhop",
    maps: [
      ws("bhop_at_night", 3077211069),
      ws("bhop_ragnarok", 3077153735),
      ws("bhop_zunron", 3077475505),
      ws("bhop_1derland", 3077596014),
      ws("bhop_whiteshit", 3078523849),
      ws("bhop_cherryblossom", 3082038560),
      ws("bhop_arcturus", 3088973190),
      ws("bhop_kiwi_cwfx", 3095219437),
    ],
  },
  {
    key: "surf", name: "Surf", cfg: "surf.cfg", mapGroup: "mg_surf",
    maps: [
      ws("surf_kitsune", 3076153623),
      ws("surf_utopia_njv", 3073875025),
      ws("surf_beginner", 3070321829),
      ws("surf_mesa_revo", 3076980482),
      ws("surf_deathstar", 3080544577),
      ws("surf_rookie", 3082548297),
      ws("surf_benevolent", 3098972556),
      ws("surf_ace", 3088413071),
      ws("surf_boreas", 3133346713),
      ws("surf_nyx", 3129698096),
      ws("surf_whiteout", 3296258256),
      ws("surf_ski_2", 3079877518),
      // Beginner-friendly additions (from CS2 Easy Surf Maps collection
      // 3275959371). All tier-1 / explicit beginner maps.
      ws("surf_easy1", 3285592319),
      ws("surf_easy2", 3285630294),
      ws("surf_how2surf", 3292018151),
      ws("surf_me", 3248211716),
      ws("surf_summer", 3488534078),
      ws("surf_lullaby", 3271149992),
      ws("surf_atrium", 3130141240),
      ws("surf_aqua_fix", 3259258220),
      ws("surf_quickie", 3165930325),
      ws("surf_paradise", 3391598488),
      // Additions per operator request 2026-05-26.
      ws("surf_leet_xl_beta7z", 3268646330),
      ws("surf_aircontrol_ksf", 3520975981),
      // Workshop didn't surface a CS2 "surf_progress_fix" — using the
      // base surf_progress (Puop) as the closest match. Swap the ID if
      // a true _fix re-upload appears.
      ws("surf_progress", 3728363741),
      ws("surf_anzchamps", 3646843549),
      ws("surf_globalchaos", 3473042302),
    ],
  },
  {
    key: "kz", name: "Kreedz Climbing", cfg: "kz.cfg", mapGroup: "mg_kz",
    maps: [
      ws("only_up", 3074758439),
      ws("kz_dima", 3343029934),
      ws("ewii_challenge", 3170668869),
      ws("hellcasecyrilchallenge", 3145779590),
      ws("kz_checkmate", 3070194623),
      ws("kz_victoria", 3086304337),
      ws("kz_rc_stonehenge", 3072219045),
      ws("kz_sxb2_cxz", 3083714192),
      ws("kz_rc_twotowers", 3083509404),
      ws("kz_simplyhard", 3078311932),
      ws("kz_nomibo", 3077122656),
      ws("kz_sxb2_biewan", 3076000218),
      ws("kz_ggsh", 3072744536),
      ws("kz_ltt", 3072699538),
    ],
  },
  {
    key: "ctf", name: "Capture The Flag", cfg: "ctf.cfg", mapGroup: "mg_ctf",
    maps: [
      ws("ctf_2fort", 3555531615),
      ws("ctf_doublecross", 3555532817),
      ws("ctf_turbine", 3555534037),
      ws("ctf_sawmill", 3611854449),
      ws("ctf_applejack", 3611844411),
      ws("ctf_landfall", 3611843310),
    ],
  },
  {
    // "Hide N Seek" in the kus image with the prophunt map pool — keep the
    // hns.cfg config since it's what loads the appropriate plugins, but
    // expose the mode under the name everyone calls it. Single-word so
    // chat-menu search-by-prefix works (operators kept missing it when
    // it was "Hide N Seek" — typing "prop" matched nothing).
    key: "hns", name: "PropHunt", cfg: "hns.cfg", mapGroup: "mg_hns",
    // The previous 5 IDs (3366748499 + 4 others) had all been deleted
    // from Workshop — `steamcmd workshop_download_item` returned File
    // Not Found for every one. Replaced 2026-05-24 with maps verified
    // currently published on workshop.
    maps: [
      ws("prophunt_inferno",        3608612434),
      ws("prophunt_mirage",         3615968422),
      ws("prophunt_mirage_alt",     3611619297),
      ws("prophunt_vertigo",        3612713525),
      ws("prophunt_italy",          3613886555),
      ws("prophunt_office",         3644811896),
      ws("prophunt_nuke",           3711322683),
    ],
  },
  {
    key: "soccer", name: "Soccer", cfg: "soccer.cfg", mapGroup: "mg_soccer",
    maps: [
      ws("field", 3238565662),
    ],
  },
  {
    key: "course", name: "Course", cfg: "course.cfg", mapGroup: "mg_course",
    maps: [
      ws("cr_devisland_p1_v1", 3076483842),
      ws("mg_switch_course_v2", 3070439729),
      ws("cr_minecraft_jb_v2", 3070896876),
      ws("mg_metro_course_v1", 3070463151),
      ws("mg_alley_course_v2", 3070455802),
      ws("mg_glave_course_v2", 3070445185),
      ws("mg_office_course_v3", 3070459211),
      ws("mg_metal_course_v2", 3070464208),
      ws("mg_acrophobia_run_v2", 3070463620),
      ws("mg_metro_course_s2", 3071040020),
      ws("mg_circle_course_v3", 3070434475),
      ws("mg_simpsons_course_v2", 3070447697),
      ws("mg_sonic_course_v2", 3070452642),
      ws("mg_sky_realm_v3", 3070451616),
    ],
  },
  {
    key: "deathrun", name: "Deathrun", cfg: "deathrun.cfg", mapGroup: "mg_deathrun",
    maps: [
      ws("deathrun_playground", 3164611860),
      ws("deathrun_egypt", 3311285877),
      ws("deathrun_civilization", 3188021118),
      ws("deathrun_iceworld_cs2", 3083325292),
    ],
  },
  {
    key: "minigames", name: "Minigames", cfg: "minigames.cfg", mapGroup: "mg_minigames",
    maps: [
      ws("mg_skeet_multigames_v7", 3082120895),
      ws("mg_lego_course_2", 3202752274),
      ws("mg_warmcup_headshot", 3076765511),
    ],
  },
  {
    // Tiny Maps — shrunk-scale community versions of the classic competitive
    // maps (dust2, mirage, inferno, …) where the geometry is the same but
    // the world is scaled down so players look huge inside it. Uses the
    // Deathmatch cfg for FFA + fast respawn. Pool intentionally empty —
    // search the Steam workshop for "Mini Dust2", "Tiny Mirage", "Small
    // Inferno" etc and add the IDs via the wizard's RTV pool editor (or
    // append `ws(name, id)` lines below).
    key: "mini", name: "Tiny Maps", cfg: "deathmatch.cfg", mapGroup: "mg_dm",
    maps: [],
  },
  // Mini Maps used to be a standalone mode (key "minimaps") but the
  // 8 mini-scale workshop maps now live inside the Competitive entry
  // above — same comp.cfg rules, just shrunken geometry. Switching
  // to a mini map via !rtv → Competitive automatically gets them
  // without needing a separate mode listing.
  {
    key: "scoutzknivez", name: "ScoutzKnivez", cfg: "scoutzknivez.cfg", mapGroup: "mg_scoutzknivez",
    maps: [
      ws("scoutzknivez_pure_cs2", 3073929825),
      ws("ar_dizzy", 3070553020),
    ],
  },
  {
    key: "oitc", name: "One In The Chamber", cfg: "oitc.cfg", mapGroup: "mg_gg",
    // OITC pool — both the tight arena-style maps (close-quarters knife fun)
    // AND the bigger bomb-defusal/hostage maps so players can also hunt each
    // other across spread-out terrain. Players pick what they feel like.
    maps: [
      // Tight arenas
      stock("ar_shoots"),
      stock("ar_shoots_night"),
      stock("ar_baggage"),
      stock("ar_pool_day"),
      ws("speedball", 3443206318),
      ws("aim_plywood", 3118710028),
      ws("gg_lego_arena", 3267768230),
      ws("de_indoor", 3535917558),
      ws("de_assembly", 3071005299),
      ws("fy_iceworld", 3070238628),
      ws("daymare", 3072640420),
      ws("mcdonalds", 3134466699),
      ws("aim_theorem", 3070348309),
      ws("de_safehouse", 3070550406),
      ws("de_lake", 3070563536),
      // Spread-out hunt-style stock maps
      stock("de_dust2"),
      stock("de_mirage"),
      stock("de_inferno"),
      stock("de_nuke"),
      stock("de_overpass"),
      stock("de_ancient"),
      stock("de_anubis"),
      stock("de_vertigo"),
      stock("de_train"),
      stock("cs_office"),
      stock("cs_italy"),
    ],
  },
  {
    key: "battle", name: "Battle Ball", cfg: "battle.cfg", mapGroup: "mg_battle",
    maps: [
      ws("battleball", 3280650663),
    ],
  },
  {
    key: "battleroyale", name: "Battle Royale", cfg: "br.cfg", mapGroup: "mg_battleroyale",
    maps: [
      ws("br_t2", 3462095803),
      ws("br_electrified", 3330484099),
      ws("br_stacks", 3297489255),
      ws("br_flood", 3267454508),
      ws("minecraft", 3186779271),
      ws("minecraft_hungergame", 3240933254),
    ],
  },
  {
    key: "casual", name: "Casual", cfg: "casual.cfg", mapGroup: "mg_active",
    maps: [
      stock("de_ancient"),
      stock("de_anubis"),
      stock("de_inferno"),
      stock("de_mirage"),
      stock("de_nuke"),
      stock("de_dust2"),
      stock("de_overpass"),
    ],
  },
  {
    key: "casual_16", name: "Casual (1.6)", cfg: "casual-1.6.cfg", mapGroup: "mg_casual-1.6",
    maps: [
      ws("as_oilrig", 3104677430),
      ws("cs_assult_classic", 3215705579),
      ws("de_aztec_classic", 3213800338),
      ws("de_dust_classic", 3078095785),
      ws("de_dust2_classic", 3201205818),
      ws("cs_italy_classic", 3212419403),
      ws("cs_militia_classic", 3144773563),
      ws("de_nuke_classic", 3205793205),
      ws("cs_office_classic", 3216844784),
      ws("de_survivor_classic_m", 3217247541),
    ],
  },
  {
    key: "valve_competitive", name: "Competitive (Valve)", cfg: "valve-competitive.cfg", mapGroup: "mg_valve_competitive",
    maps: [
      stock("de_dust2"),
      stock("de_mirage"),
      stock("de_inferno"),
      stock("de_ancient_night"),
      stock("de_nuke"),
      stock("de_train"),
      stock("de_overpass"),
      stock("de_anubis"),
      stock("de_vertigo"),
      stock("de_warden"),
      stock("de_stronghold"),
      stock("cs_alpine"),
      stock("cs_office"),
      stock("cs_italy"),
    ],
  },
  {
    key: "valve_deathmatch", name: "Deathmatch FFA (Valve)", cfg: "valve-deathmatch-freeforall.cfg", mapGroup: "mg_valve_deathmatch",
    maps: [
      stock("de_dust2"),
      stock("de_mirage"),
      stock("de_inferno"),
      stock("de_ancient_night"),
      stock("de_nuke"),
      stock("de_train"),
      stock("de_overpass"),
      stock("de_anubis"),
      stock("de_vertigo"),
      stock("de_warden"),
      stock("de_stronghold"),
      stock("cs_alpine"),
      stock("cs_office"),
      stock("cs_italy"),
    ],
  },
  {
    key: "valve_armsrace", name: "Arms Race (Valve)", cfg: "valve-armsrace.cfg", mapGroup: "mg_valve_arms_race",
    maps: [
      stock("ar_baggage"),
      stock("ar_shoots"),
      stock("ar_shoots_night"),
      stock("ar_pool_day"),
    ],
  },
  {
    key: "valve_wingman", name: "Wingman (Valve)", cfg: "valve-wingman.cfg", mapGroup: "mg_valve_wingman",
    maps: [
      stock("de_sanctum"),
      stock("de_poseidon"),
      stock("de_overpass"),
      stock("de_vertigo"),
      stock("de_nuke"),
      stock("de_inferno"),
    ],
  },
  {
    key: "valve_retake", name: "Retakes (Valve)", cfg: "valve-retake.cfg", mapGroup: "mg_valve_retakes",
    maps: [
      stock("de_dust2"),
      stock("de_mirage"),
      stock("de_inferno"),
      stock("de_ancient_night"),
      stock("de_nuke"),
      stock("de_train"),
      stock("de_overpass"),
      stock("de_anubis"),
      stock("de_vertigo"),
    ],
  },
  {
    key: "comp_45", name: "Competitive 45°", cfg: "45.cfg", mapGroup: "mg_45",
    maps: [
      ws("de_vertigo_45", 3276886893),
      ws("de_anubis_silly", 3245985233),
      ws("de_overpass_45", 3270066070),
      ws("de_nuke_silly", 3245245780),
      ws("de_mirage45", 3270516952),
      ws("de_train_twyxe", 3406937162),
    ],
  }
]

// RTV vote tuning — see GameCtlRtvConfig in /cs2-plugin/GameCtlRtv.cs.
export const CS2_RTV_TUNING = {
  rtv_percentage: 60,     // % of connected humans that must !rtv to start
  mode_vote_duration: 25, // seconds — stage 1 (mode)
  map_vote_duration: 25,  // seconds — stage 2 (map)
  change_delay: 6,        // seconds between exec'ing the mode cfg and the map change
}

// The command list the GameCtlRtv plugin prints for !help.
export const CS2_RTV_HELP = [
  { cmd: '!rtv', desc: 'Two-stage vote — pick a new game mode, then a map' },
  { cmd: '!unrtv', desc: 'Take back your rock-the-vote' },
  { cmd: '!modes', desc: '[admin] Switch game mode (private picker)' },
  { cmd: '!maps', desc: '[admin] Switch map within the current mode (private picker)' },
  { cmd: '!timeleft', desc: 'Show how long is left on the current map' },
  { cmd: '!help', desc: 'Show this list of commands' },
]

export function catalogMode(modeKey) {
  return CS2_RTV_CATALOG.find((m) => m.key === modeKey) || null
}

function filterMaps(mode, pool) {
  const sel = pool && pool[mode.key]
  const maps = Array.isArray(sel) ? mode.maps.filter((m) => sel.includes(m.id)) : mode.maps
  return maps.map((m) => ({ name: m.name, id: m.id, workshop: m.workshop }))
}

export function buildRtvConfigJson(pool, welcomeMessage = '') {
  return JSON.stringify({
    ConfigVersion: 1,
    ...CS2_RTV_TUNING,
    welcome_message: welcomeMessage || '',
    welcome_delay: 3,
    help: CS2_RTV_HELP,
    modes: CS2_RTV_CATALOG
      .map((m) => ({ name: m.name, cfg: m.cfg, maps: filterMaps(m, pool) }))
      .filter((m) => m.maps.length > 0),
  }, null, 2)
}

export function rtvWorkshopIds(pool) {
  const ids = new Set()
  for (const mode of CS2_RTV_CATALOG)
    for (const map of filterMaps(mode, pool))
      if (map.workshop) ids.add(map.id)
  return [...ids]
}

export function buildGameModesList() {
  return CS2_RTV_CATALOG.map((m) => ({
    Name: m.name,
    Config: m.cfg,
    DefaultMap: m.maps[0]?.id ?? null,
    MapGroups: [m.mapGroup],
  }))
}
