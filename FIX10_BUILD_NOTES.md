# FIX10 — Vercel build error fix

Screenshot error:
- `src/render/vehicleMesh.ts(8,10): error TS6133: 'VEHICLE_CELL' is declared but its value is never read.`

Fix:
- Removed the unused `VEHICLE_CELL` import from `src/render/vehicleMesh.ts`.
- No traffic behavior, timing, lane, spawn, or rendering logic was otherwise changed.
