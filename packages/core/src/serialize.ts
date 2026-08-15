import type { FeatureBlocks } from './types.js'

/** FeatureBlocks ↔ JSON (IPC Tauri / store). Float32Array → number[]. */
export interface FeatureBlocksJson {
  face: number[] | null
  hands: [number[] | null, number[] | null]
  /** Absent des données v1 : désérialisé en [null, null]. */
  handPos?: [number[] | null, number[] | null]
}

export function blocksToJson(b: FeatureBlocks): FeatureBlocksJson {
  return {
    face: b.face ? Array.from(b.face) : null,
    hands: [
      b.hands[0] ? Array.from(b.hands[0]) : null,
      b.hands[1] ? Array.from(b.hands[1]) : null,
    ],
    handPos: [
      b.handPos[0] ? Array.from(b.handPos[0]) : null,
      b.handPos[1] ? Array.from(b.handPos[1]) : null,
    ],
  }
}

export function blocksFromJson(j: FeatureBlocksJson): FeatureBlocks {
  return {
    face: j.face ? Float32Array.from(j.face) : null,
    hands: [
      j.hands[0] ? Float32Array.from(j.hands[0]) : null,
      j.hands[1] ? Float32Array.from(j.hands[1]) : null,
    ],
    handPos: [
      j.handPos?.[0] ? Float32Array.from(j.handPos[0]) : null,
      j.handPos?.[1] ? Float32Array.from(j.handPos[1]) : null,
    ],
  }
}
