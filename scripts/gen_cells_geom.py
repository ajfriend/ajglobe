# /// script
# requires-python = ">=3.11"
# dependencies = ["h3>=4", "numpy>=1.24"]
# ///
"""Generate H3 cell geometry + IDs for the ajglobe two-globe example.

Pass one of two (the other is gen_cells_ar.py, which adds the skar AR). For each
resolution in RES_LIST, writes three files to ajglobe/examples/data/ (gitignored):

  h3_r{res}_pos.f32   Float32 [lng, lat] ring vertices, flattened.
  h3_r{res}_idx.u32   Uint32 per-cell ring start indices (len = n_cells + 1).
  h3_r{res}_ids.json  H3 cell ID strings, one per cell, in the SAME order.

ajglobe draws in 3D (lng/lat -> xyz, periodic), so rings need no antimeridian
unwrap. Cells are sorted by ID so pos/idx/ids (and the AR pass) align by index.

Run (edit RES_LIST below — no CLI args, project convention):
    uv run scripts/gen_cells_geom.py
"""

import json
from pathlib import Path

import h3
import numpy as np

# ----- knobs --------------------------------------------------------------
RES_LIST = [1, 2]      # H3 resolutions (0..15). r1 ~842 cells, r2 ~5.9k.
OUT = Path.home() / 'work' / 'ajglobe' / 'examples' / 'data'
# --------------------------------------------------------------------------


def cells(res):
    """Yield (id_str, [(lat, lng), ...]) for every H3 cell at res, sorted by id."""
    res0 = h3.get_res0_cells()
    cids = list(res0) if res == 0 else [c for c0 in res0 for c in h3.cell_to_children(c0, res)]
    for cid in sorted(cids):
        yield cid, list(h3.cell_to_boundary(cid))   # [(lat, lng), ...] degrees


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for res in RES_LIST:
        pos, starts, ids, n = [], [0], [], 0
        for cid, ring in cells(res):
            for lat, lng in ring:
                pos.append((lng, lat))               # [lng, lat] (ajglobe / GeoJSON order)
                n += 1
            starts.append(n)
            ids.append(cid)
        name = f'h3_r{res}'
        np.asarray(pos, dtype='<f4').tofile(OUT / f'{name}_pos.f32')
        np.asarray(starts, dtype='<u4').tofile(OUT / f'{name}_idx.u32')
        (OUT / f'{name}_ids.json').write_text(json.dumps(ids))
        print(f'h3 r{res}: {len(ids):,} cells, {n:,} verts -> {OUT}/{name}_*')


if __name__ == '__main__':
    main()
