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
};

// (lng, lat) degrees -> unit vector. z = north pole. No seams: this is the
// whole point — every vertex becomes a point on the sphere, antimeridian and
// poles included, with no special handling anywhere downstream.
export function lnglatToVec3(lngDeg, latDeg) {
  const lng = (lngDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180;
  const c = Math.cos(lat);
  return [c * Math.cos(lng), c * Math.sin(lng), Math.sin(lat)];
}

export const quat = {
  identity: () => [0, 0, 0, 1],
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
  fromAxisAngle(axis, angle) {
    const a = vec3.norm(axis), s = Math.sin(angle / 2);
    return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
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
};

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
};
