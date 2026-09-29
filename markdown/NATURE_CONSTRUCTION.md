# Construction and nature rollout

## Stage 1 — systems

- A displayed life day is 600 real seconds at 1×; the clock, construction deadlines, weather and commute schedules share persisted `macro.lifeElapsedMs`. Pausing freezes them; offline absence does not silently complete construction or advance disasters. The older growth/economy tick calendar remains separate.
- Every single placement tool selects a location before the existing confirmation bar commits it. Player-built facilities and metro stations reserve their complete footprint, charge once at confirmation, and become operational only after construction finishes. Roads, utility lines and zoning keep their existing immediate confirmed placement.
- Construction lasts `120 + 90 × footprint area` life minutes, capped at three life days. Selection shows duration; clicking a site shows deadline and progress. Demolition cancels the entire site without refund. Save data retains reservations and deadlines.
- Night uses blue ambient tint on world terrain/structures/vehicles. DOM interface, placement previews and alert icons are not tinted. Sunset introduces warm tones; there is no whole-canvas grayscale/brightness filter.
- Weather provides precipitation rate (mm/game hour), temperature (°C), wind vector (m/s) and cloud cover. Natural changes are gradual and deterministic; administrators can override rain, snow and wind or restore natural weather.
- Natural disasters start only through the local administrator tools: typhoon, flood, blizzard, earthquake. Strength is 1–5. Typhoon/blizzard paths use direction (0° north, 90° east in tile coordinates), speed in tiles/life hour and the current map center. Storms expire after half a life day; earthquakes after about 29 life minutes. Starting another replaces the active event. Stop removes the source, not accumulated water, snow or damage.
- Typhoon wind has a calm eye, strongest eyewall, counterclockwise tangential wind, radial inflow and falloff. Surface water moves toward lower neighboring hydraulic head. Snow accumulates, melts with positive temperature and contributes meltwater. Weather reduces vehicle target speeds at their own positions. High wind, inundation, snow loading and earthquake exposure accumulate structural damage and can demolish buildings.

## Model boundaries

This is a deterministic gameplay model, not a calibrated weather forecast or engineering hazard solver. Hydrology starts at developed building tiles and spreads onto neighboring explored land; it does not simulate a complete watershed, river discharge, ocean tides, storm surge or a groundwater table. Ground elevation uses a nominal three metres per terrain level. Wind affects driving through local precipitation/traction now; projectiles, aircraft flight physics and warfare consumers are future integrations. Buildings currently accumulate scalar damage and eventually collapse; repair policy and detailed structural materials are future work. The existing fire/crime/disease system remains separate from administrator-triggered natural disasters.

## Validation

`node tools/check/run.mjs natureConstruction dailyLife placement metro balance traffic gameUi disaster service`

The new check covers confirmation/cancel, footprint reservation, one-time cost, deadline boundary and save restoration, inactive unfinished facilities/stations, typhoon eye/path, local driving grip, snow/melting, downhill runoff, fixed-step damage and coloured night. Production build uses `npm run build`.
