// Minimal vec3 / quaternion / mat4 math (column-major mat4, WebGL order).
// Zero-dependency; only what ajglobe's orthographic globe needs.

export const vec3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  // Angle (radians) between two unit vectors.
  angle: (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))),
  // Unit tangent at v pointing along the geodesic toward u (u's component ⊥ v).
  tangent: (v, u) => {
    const d = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    return vec3.norm([u[0] - d * v[0], u[1] - d * v[1], u[2] - d * v[2]]);
  },
  // Spherical lerp of two unit vectors — the great-circle midpoint family. Stays
  // on the sphere, so it densifies an edge into a geodesic arc (seam/pole-safe).
  slerp(a, b, t) {
    const om = vec3.angle(a, b);
    if (om < 1e-6) return [a[0], a[1], a[2]];
    const so = Math.sin(om), c0 = Math.sin((1 - t) * om) / so, c1 = Math.sin(t * om) / so;
    return [a[0] * c0 + b[0] * c1, a[1] * c0 + b[1] * c1, a[2] * c0 + b[2] * c1];
  },
};

// (lng, lat) degrees -> unit vector, written into out[off..off+2]. z = north
// pole. No seams: this is the whole point — every vertex becomes a point on the
// sphere, antimeridian and poles included, with no special handling downstream.
// The in-place form is allocation-free for hot per-vertex loops (millions of
// verts); lnglatToVec3 wraps it for one-off callers.
export function lnglatToVec3Into(out, off, lngDeg, latDeg) {
  const lng = (lngDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180;
  const c = Math.cos(lat);
  out[off] = c * Math.cos(lng);
  out[off + 1] = c * Math.sin(lng);
  out[off + 2] = Math.sin(lat);
}

export function lnglatToVec3(lngDeg, latDeg) {
  const v = [0, 0, 0];
  lnglatToVec3Into(v, 0, lngDeg, latDeg);
  return v;
}

// Inverse of lnglatToVec3: a unit vector -> { lng, lat } in degrees.
export function vec3ToLngLat(v) {
  return {
    lng: Math.atan2(v[1], v[0]) * 180 / Math.PI,
    lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) * 180 / Math.PI,
  };
}

export const quat = {
  identity: () => [0, 0, 0, 1],
  // Rotation of `angle` radians about a (unit-normalized) axis.
  fromAxisAngle(axis, angle) {
    const a = vec3.norm(axis), s = Math.sin(angle / 2);
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
  },
  // Shortest-arc rotation taking unit vector a onto unit vector b.
  fromUnitVectors(a, b) {
    let d = vec3.dot(a, b);
    if (d > 0.999999) return [0, 0, 0, 1];
    if (d < -0.999999) {
      // antiparallel: rotate 180° about any axis orthogonal to a
      let ax = vec3.cross([1, 0, 0], a);
      if (vec3.len(ax) < 1e-6) ax = vec3.cross([0, 1, 0], a);
      ax = vec3.norm(ax);
      return [ax[0], ax[1], ax[2], 0];
    }
    const c = vec3.cross(a, b);
    const q = [c[0], c[1], c[2], 1 + d];
    return quat.normalize(q);
  },
  multiply(a, b) {
    const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
  normalize(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  },
  // Rotate vector v by quaternion q: v + 2w(qxv) + 2 qx(qxv).
  rotateVec3(q, v) {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
      v[0] + w * tx + (y * tz - z * ty),
      v[1] + w * ty + (z * tx - x * tz),
      v[2] + w * tz + (x * ty - y * tx),
    ];
  },
};

const DEG = Math.PI / 180;

// Object-space unit "north" (∂position/∂lat) at a lng/lat in degrees — the tangent
// pointing toward the north pole. Used to define/read the screen roll of an orientation.
function northAt(lngDeg, latDeg) {
  const lng = lngDeg * DEG, lat = latDeg * DEG, s = Math.sin(lat);
  return [-s * Math.cos(lng), -s * Math.sin(lng), Math.cos(lat)];
}

// (lng, lat, roll) degrees -> the model orientation (unit quaternion) that centers
// that point on the view axis with the given screen roll (0 = north up). Inverse of
// quatToLngLat. Two shortest-arc steps — center->+z, then lift north to screen-up —
// then the roll about the view axis.
export function lnglatToQuat(lngDeg, latDeg, rollDeg = 0) {
  const center = lnglatToVec3(lngDeg, latDeg);
  const q1 = quat.fromUnitVectors(center, [0, 0, 1]);                 // center -> +z
  const n1 = quat.rotateVec3(q1, northAt(lngDeg, latDeg));            // north, now ⊥ +z
  let q = quat.multiply(quat.fromUnitVectors(vec3.norm([n1[0], n1[1], 0]), [0, 1, 0]), q1);
  if (rollDeg) q = quat.multiply(quat.fromAxisAngle([0, 0, 1], rollDeg * DEG), q);
  return quat.normalize(q);
}

// Inverse of lnglatToQuat: a model orientation -> { lng, lat, roll } in degrees.
// lng/lat is the geographic point at screen center (q⁻¹·+z); roll is the angle of
// local north away from screen-up. lng/roll degenerate at the poles (lat = ±90).
export function quatToLngLat(q) {
  const [x, y, z, w] = q;
  const center = quat.rotateVec3([-x, -y, -z, w], [0, 0, 1]);         // conjugate · +z
  const { lng, lat } = vec3ToLngLat(center);
  const nv = quat.rotateVec3(q, northAt(lng, lat));                   // north in view space
  return { lng, lat, roll: Math.atan2(-nv[0], nv[1]) / DEG };
}

export const mat4 = {
  multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
          + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
  fromQuat(q) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return new Float32Array([
      1 - (yy + zz), xy + wz, xz - wy, 0,
      xy - wz, 1 - (xx + zz), yz + wx, 0,
      xz + wy, yz - wx, 1 - (xx + yy), 0,
      0, 0, 0, 1,
    ]);
  },
  ortho(l, r, b, t, n, f) {
    const lr = 1 / (l - r), bt = 1 / (b - t), nf = 1 / (n - f);
    return new Float32Array([
      -2 * lr, 0, 0, 0,
      0, -2 * bt, 0, 0,
      0, 0, 2 * nf, 0,
      (l + r) * lr, (t + b) * bt, (f + n) * nf, 1,
    ]);
  },
  lookAt(eye, center, up) {
    let z = vec3.norm(vec3.sub(eye, center));
    let x = vec3.norm(vec3.cross(up, z));
    let y = vec3.cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -vec3.dot(x, eye), -vec3.dot(y, eye), -vec3.dot(z, eye), 1,
    ]);
  },
  // m (column-major) times a 4-vector -> 4-vector.
  mulVec4(m, v) {
    return [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
      m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
  },
  // General 4x4 inverse (column-major); returns null if singular. Needed by
  // unproject to turn a screen ray back into world space.
  invert(m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    return new Float32Array([
      (a11 * b11 - a12 * b10 + a13 * b09) * det,
      (a02 * b10 - a01 * b11 - a03 * b09) * det,
      (a31 * b05 - a32 * b04 + a33 * b03) * det,
      (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det,
      (a00 * b11 - a02 * b08 + a03 * b07) * det,
      (a32 * b02 - a30 * b05 - a33 * b01) * det,
      (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det,
      (a01 * b08 - a00 * b10 - a03 * b06) * det,
      (a30 * b04 - a31 * b02 + a33 * b00) * det,
      (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det,
      (a00 * b09 - a01 * b07 + a02 * b06) * det,
      (a31 * b01 - a30 * b03 - a32 * b00) * det,
      (a20 * b03 - a21 * b01 + a22 * b00) * det,
    ]);
  },
};
