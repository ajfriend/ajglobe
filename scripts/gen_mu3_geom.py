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
RES_LIST = list(range(7))      # mu3 resolutions; counts 12, 72, 492, 3432, 24012, 168072, 1176492
OUT = Path.home() / 'work' / 'ajglobe' / 'examples' / 'data'
# --------------------------------------------------------------------------


def unrank(res, i):
    '''Cell tuple from its cells_at_res rank. Mirrors the JS lex unranking in
    examples/mu3-ar.html (which recovers hover ids from pick indices instead of
    shipping an ids.json); sample-checked during generation below so a change
    to mu3's enumeration order fails here instead of silently mislabeling
    every hovered cell.'''
    v = [1]                       # v[m]: valid length-m tails while prefix is all zeros
    for m in range(1, res + 1):
        v.append(v[-1] + 5 * 7 ** (m - 1))
    base, r = divmod(i, v[res])
    digits, zero = [], True
    for m in range(res - 1, -1, -1):
        if zero and r < v[m]:
            digits.append(0)
            continue
        if zero:
            r -= v[m]
            d, r = divmod(r, 7 ** m)
            digits.append(d + 2)  # digit 1 is skipped
            zero = False
        else:
            d, r = divmod(r, 7 ** m)
            digits.append(d)
    return (base, *digits)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for res in RES_LIST:
        t0 = time.perf_counter()
        rings, counts = [], []
        for i, cell in enumerate(cells_at_res(res)):
            if i % 997 == 0:
                assert unrank(res, i) == tuple(cell), f'enumeration order changed at r{res} i={i}'
            rings.append(cell_boundary(cell, closed=False))   # (M, 3) unit vec3
            counts.append(len(rings[-1]))
        xyz = np.concatenate(rings)                           # one vectorized pass
        lng = np.degrees(np.arctan2(xyz[:, 1], xyz[:, 0]))
        lat = np.degrees(np.arcsin(np.clip(xyz[:, 2], -1, 1)))
        starts = np.concatenate([[0], np.cumsum(counts)])
        name = f'mu3_r{res}'
        np.column_stack([lng, lat]).astype('<f4').tofile(OUT / f'{name}_pos.f32')
        starts.astype('<u4').tofile(OUT / f'{name}_idx.u32')
        dt = time.perf_counter() - t0
        print(f'mu3 r{res}: {len(counts):,} cells, {len(xyz):,} verts in {dt:.1f}s -> {OUT}/{name}_*')


if __name__ == '__main__':
    main()
