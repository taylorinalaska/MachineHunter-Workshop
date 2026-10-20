/**
 * Ready-made props for the prop builder. Sizes are in steps: 16 to a cell
 * side and to a layer's height. Walls run east-west through the middle of
 * the cell, a quarter of a cell thick; turn the parts to run them north-south.
 */
import type { PartShape, PropPart } from '@mh/core';

type Spec = [shape: PartShape, x: number, y: number, z: number, w: number, d: number, h: number, extra?: Partial<PropPart>];

export interface PropPreset {
  name: string;
  parts: Spec[];
}

export const PROP_PRESETS: PropPreset[] = [
  {
    name: 'Window',
    parts: [
      ['box', 0, 6, 0, 16, 4, 6],
      ['box', 0, 6, 12, 16, 4, 4],
      ['box', 0, 6, 6, 5, 4, 6],
      ['box', 11, 6, 6, 5, 4, 6],
      ['box', 4, 5, 5, 8, 6, 1],
    ],
  },
  {
    name: 'Doorway',
    parts: [
      ['box', 0, 6, 0, 4, 4, 16],
      ['box', 12, 6, 0, 4, 4, 16],
      ['box', 4, 6, 12, 8, 4, 4],
    ],
  },
  {
    name: 'Door',
    parts: [
      ['box', 0, 6, 0, 4, 4, 16],
      ['box', 12, 6, 0, 4, 4, 16],
      ['box', 4, 6, 12, 8, 4, 4],
      ['box', 4, 7, 0, 8, 2, 12],
    ],
  },
  {
    name: 'Wall',
    parts: [['box', 0, 6, 0, 16, 4, 16]],
  },
  {
    name: 'Column',
    parts: [
      ['box', 3, 3, 0, 10, 10, 2],
      ['cylinder', 4, 4, 2, 8, 8, 12, { sides: 8 }],
      ['box', 3, 3, 14, 10, 10, 2],
    ],
  },
  {
    name: 'Stairs',
    parts: [
      ['box', 0, 12, 0, 16, 4, 4],
      ['box', 0, 8, 0, 16, 4, 8],
      ['box', 0, 4, 0, 16, 4, 12],
      ['box', 0, 0, 0, 16, 4, 16],
    ],
  },
  {
    name: 'Table',
    parts: [
      ['box', 2, 4, 0, 1, 1, 7],
      ['box', 13, 4, 0, 1, 1, 7],
      ['box', 2, 11, 0, 1, 1, 7],
      ['box', 13, 11, 0, 1, 1, 7],
      ['box', 1, 3, 7, 14, 10, 1],
    ],
  },
  {
    name: 'Crate',
    parts: [['box', 2, 2, 0, 12, 12, 12]],
  },
  {
    name: 'Barrel',
    parts: [['cylinder', 3, 3, 0, 10, 10, 10, { sides: 8 }]],
  },
  {
    name: 'Fence',
    parts: [
      ['box', 0, 7, 0, 2, 2, 8],
      ['box', 7, 7, 0, 2, 2, 8],
      ['box', 14, 7, 0, 2, 2, 8],
      ['box', 0, 7, 6, 16, 1, 1],
      ['box', 0, 7, 3, 16, 1, 1],
    ],
  },
  {
    name: 'Hut',
    parts: [
      ['box', 2, 2, 0, 12, 12, 8],
      ['roof', 1, 1, 8, 14, 14, 6],
    ],
  },
  {
    name: 'Tower',
    parts: [
      ['box', 3, 3, 0, 10, 10, 10],
      ['pyramid', 2, 2, 10, 12, 12, 6],
    ],
  },
  {
    name: 'Lamp',
    parts: [
      ['box', 5, 5, 0, 6, 6, 1],
      ['cylinder', 7, 7, 1, 2, 2, 11, { sides: 6 }],
      ['box', 5, 5, 12, 6, 6, 3],
      ['pyramid', 5, 5, 15, 6, 6, 1],
    ],
  },
  {
    name: 'Ramp',
    parts: [['wedge', 0, 0, 0, 16, 16, 16]],
  },
];

export function presetParts(preset: PropPreset, tile: number): PropPart[] {
  return preset.parts.map(([shape, x, y, z, w, d, h, extra]) => ({ shape, x, y, z, w, d, h, turn: 0, tile, ...extra }));
}
