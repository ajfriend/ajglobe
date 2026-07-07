"""Add the skar aspect ratio (AR) to generated cell geometry.

Pass two: reads {name}_pos.f32 / {name}_idx.u32 (from gen_cells_geom.py), solves
each cell with skar, and writes one float per cell:

  {name}_ar.f32   Float32 AR per cell (NaN = did-not-converge), same cell order.

skar is built in the skar_py repo, so run this in skar_py's prebuilt env (no inline
deps here on purpose). From the skar_py dir:

    cd ~/work/skar_py && uv run --no-sync ~/work/ajglobe/scripts/gen_cells_ar.py

(if `import skar` fails, run `just reinstall` in skar_py first to rebuild it.)
Edit NAMES below (no CLI args, project convention).
"""

from pathlib import Path

import numpy as np

import skar

# ----- knobs --------------------------------------------------------------
NAMES = [f'mu3_r{n}' for n in range(7)]   # each must match a gen_*_geom.py output stem
OUT = Path.home() / 'work' / 'ajglobe' / 'examples' / 'data'
GAP_TOL = 1e-6
# --------------------------------------------------------------------------


def solve_one(name):
    pos = np.fromfile(OUT / f'{name}_pos.f32', dtype='<f4').reshape(-1, 2)   # [lng, lat]
    idx = np.fromfile(OUT / f'{name}_idx.u32', dtype='<u4')
    n = len(idx) - 1
    ar = np.empty(n, dtype='<f4')
    dnc = 0
    for i in range(n):
        ring = pos[idx[i]:idx[i + 1]]
        latlng = ring[:, ::-1].astype(float)          # (k, 2) [lat, lng]
        r = skar.solve(skar.to_vec3(latlng, geo='latlng_deg'), geo='vec3', gap_tol=GAP_TOL)
        if isinstance(r, skar.Converged):
            ar[i] = r.aspect_ratio
        else:
            ar[i] = np.nan
            dnc += 1
    ar.tofile(OUT / f'{name}_ar.f32')
    finite = ar[np.isfinite(ar)]
    print(f'{name}: {n:,} cells, DNC {dnc:,}, '
          f'AR min {finite.min():.4f} / median {np.median(finite):.4f} / max {finite.max():.4f}')


def main():
    for name in NAMES:
        solve_one(name)


if __name__ == '__main__':
    main()
