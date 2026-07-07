# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=1.24", "mu3 @ file:///Users/aj/work/mu3_all/mu3_code"]
# ///
"""Generate mu3 cell geometry for the ajglobe mu3-AR example.

Same layout as gen_cells_geom.py (the H3 pass), but no _ids.json: mu3's
cells_at_res() enumerates in canonical lex order, so the example reconstructs a
cell's id from its index in JS (lex unranking) instead of shipping id strings —
at res 6 (1,176,492 cells) that JSON would be ~13 MB. For each resolution in
RES_LIST, writes two files to examples/data/ (gitignored):

  mu3_r{res}_pos.f32   Float32 [lng, lat] ring vertices, flattened (open rings).
  mu3_r{res}_idx.u32   Uint32 per-cell ring start indices (len = n_cells + 1).

Cell order is cells_at_res() order (canonical). Pentagons contribute 5 verts,
hexes 6. The AR pass is gen_cells_ar.py (run in skar_py's env; edit its NAMES).

Run (edit RES_LIST below — no CLI args, project convention):
    uv run scripts/gen_mu3_geom.py
"""

import time
from pathlib import Path

import numpy as np
from mu3 import cell_boundary, cells_at_res

# ----- knobs --------------------------------------------------------------
RES_LIST = [5, 6]              # mu3 resolutions; counts 12, 72, 492, 3432, 24012, 168072, 1176492
OUT = Path.home() / 'work' / 'ajglobe' / 'examples' / 'data'
# --------------------------------------------------------------------------


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for res in RES_LIST:
        t0 = time.perf_counter()
        pos, starts, n_cells, n = [], [0], 0, 0
        for cell in cells_at_res(res):
            ring = cell_boundary(cell, closed=False)          # (M, 3) unit vec3
            lng = np.degrees(np.arctan2(ring[:, 1], ring[:, 0]))
            lat = np.degrees(np.arcsin(np.clip(ring[:, 2], -1, 1)))
            pos.append(np.column_stack([lng, lat]))
            n += len(ring)
            starts.append(n)
            n_cells += 1
        name = f'mu3_r{res}'
        np.concatenate(pos).astype('<f4').tofile(OUT / f'{name}_pos.f32')
        np.asarray(starts, dtype='<u4').tofile(OUT / f'{name}_idx.u32')
        dt = time.perf_counter() - t0
        print(f'mu3 r{res}: {n_cells:,} cells, {n:,} verts in {dt:.1f}s -> {OUT}/{name}_*')


if __name__ == '__main__':
    main()
