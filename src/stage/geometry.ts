// Stage geometry — mirrors order-block.com/app/orderblock #stage exactly.
// Constants below are lifted from the reference DOM (1920x1200 stage, scaled).
// Lane x/w and slot y/h come straight from the reference tiles.

export const STAGE_W = 1920;
export const STAGE_H = 1200;

/** The board packs 20 rows per side into four lanes, c4 (small, far) -> c1 (picks). */
export interface LaneSlot {
  y: number;
  h: number;
}

export interface Lane {
  key: 'c1' | 'c2' | 'c3' | 'c4';
  x: number;
  w: number;
  slots: LaneSlot[];
}

const SLOTS_C1: LaneSlot[] = [
  { y: 20, h: 230 },
  { y: 256, h: 164 },
  { y: 426, h: 156 },
];
const SLOTS_C2: LaneSlot[] = [
  { y: 20, h: 139 },
  { y: 165, h: 138 },
  { y: 309, h: 135 },
  { y: 450, h: 132 },
];
const SLOTS_C3: LaneSlot[] = [
  { y: 20, h: 111 },
  { y: 137, h: 109 },
  { y: 252, h: 108 },
  { y: 366, h: 106 },
  { y: 478, h: 104 },
];
const SLOTS_C4: LaneSlot[] = [
  { y: 20, h: 67 },
  { y: 93, h: 67 },
  { y: 166, h: 66 },
  { y: 238, h: 66 },
  { y: 310, h: 66 },
  { y: 382, h: 65 },
  { y: 453, h: 65 },
  { y: 524, h: 66 },
];

export const LANES: Lane[] = [
  { key: 'c1', x: 1168, w: 172, slots: SLOTS_C1 },
  { key: 'c2', x: 1030, w: 132, slots: SLOTS_C2 },
  { key: 'c3', x: 910, w: 114, slots: SLOTS_C3 },
  { key: 'c4', x: 810, w: 94, slots: SLOTS_C4 },
];

/** Bear side is a vertical mirror of the bull side, offset by this many px. */
export const BEAR_Y_OFFSET = 590;

/** 3 picks per side ride the right edge of the tile block, above the bridges. */
export const ROW_PER_LANE = { c1: 3, c2: 4, c3: 5, c4: 8 } as const;
export const BOARD_PER_SIDE = 20;

/** Fixed rail columns (reference values). */
export const CHIPS_X = 72;
export const CHIP_DY = 26;
export const LADDER_X = 584;
export const TILES_X = 810;
export const BRIDGES_X = 1340;
export const BRIDGES_W = 28;
export const TICKETS_X = 1368;
export const TICKETS_W = 528;

/** Node x-positions (reference #nodes). */
export const NODE = {
  beacon: 66,
  now: 590,
  gate: 690,
  lens: 810,
  reactor: 1354,
} as const;

/** Count pills sit beside their node. */
export const COUNT = {
  universe: { x: 583, top: 692 },
  board: { x: 698, top: 692 },
  picks: { x: 1374, top: 590 },
} as const;

/** Crest block (reference #crest). */
export const CREST = { x: 24, y: 12, w: 672, h: 82 } as const;

/** Spine band (reference #cvSpine) — the full-width funnel floor. */
export const SPINE = { x: 40, y: 556, w: 1880, h: 186.857 } as const;

/** Funnel lens box (reference #cvLens), between the now line and the gate. */
export const LENS = { x: 686, y: 0, w: 690, h: 1200 } as const;

/** The "now" vertical line (reference #nowLine + #nowGlow). */
export const NOW_LINE = { x: 590, y: 96, h: 1056 } as const;

/** Bridge bar y-tops per side (reference #bridges), stage coords, h=110. */
export const BRIDGE_TOPS = {
  bull: [125, 328, 494],
  bear: [715, 917.5, 1083.5],
} as const;

/** Pick glow rects behind the c1 tiles (reference .ret), stage coords. */
export const RET = {
  x: 1163,
  w: 182,
  bull: [
    { y: 15, h: 240 },
    { y: 251, h: 174 },
    { y: 421, h: 166 },
  ],
  bear: [
    { y: 605, h: 240 },
    { y: 841, h: 174 },
    { y: 1010, h: 166 },
  ],
} as const;

/** Index-tag strip (reference #idxTags). */
export const IDXTAGS = { x: 72, y: 470, w: 456 } as const;

/** Distribute board rows into lanes: c1 <- picks, then c2/c3/c4 by rank. */
export function laneForRank(rank: number): Lane {
  if (rank <= ROW_PER_LANE.c1) return LANES[0];
  if (rank <= ROW_PER_LANE.c1 + ROW_PER_LANE.c2) return LANES[1];
  if (rank <= ROW_PER_LANE.c1 + ROW_PER_LANE.c2 + ROW_PER_LANE.c3) return LANES[2];
  return LANES[3];
}

/** Slot index within a lane for a rank (1-based). */
export function slotIndex(rank: number): number {
  if (rank <= ROW_PER_LANE.c1) return rank - 1;
  if (rank <= ROW_PER_LANE.c1 + ROW_PER_LANE.c2) return rank - ROW_PER_LANE.c1 - 1;
  if (rank <= ROW_PER_LANE.c1 + ROW_PER_LANE.c2 + ROW_PER_LANE.c3) {
    return rank - ROW_PER_LANE.c1 - ROW_PER_LANE.c2 - 1;
  }
  return rank - ROW_PER_LANE.c1 - ROW_PER_LANE.c2 - ROW_PER_LANE.c3 - 1;
}