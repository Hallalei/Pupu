/**
 * 把世界画成一帧。一帧由很多子帧叠成：每个子帧的时间、镜头光圈、月光方向、天光方向都抖一下，
 * 叠完就有了运动模糊、景深、软阴影和天光遮蔽，不用另外做。累积缓冲的老办法。
 */
import { chain, cross, invert, lookAt, normalize, ortho, perspective, rotateZ, type Mat4, type Vec3 } from "../../../apps/cloud/src/client/pupu-camera.ts";
import type { Mesh } from "../../../apps/cloud/src/client/pupu-voxels.ts";
import { INSTANCE_FLOATS, colorTarget, program, reserve, shadowTarget, upload, type Part, type Target } from "./gl.ts";
import * as shaders from "./shaders.ts";

export type Env = {
  top: Vec3;
  mid: Vec3;
  low: Vec3;
  below: Vec3;
  glowDir: Vec3;
  glowColor: Vec3;
  keyDir: Vec3;
  keyColor: Vec3;
  keySpread: number;
  rimDir: Vec3;
  rimColor: Vec3;
  domeGain: number;
  ambient: Vec3;
  stars: number;
  fog: Vec3;
  exposure: number;
  flash: Vec3;
  bloom: number;
  vignette: number;
  fade: number;
  shadowCenter: Vec3;
  shadowRadius: number;
};

export type Cam = { eye: Vec3; target: Vec3; fov: number; focus: number; aperture: number; roll: number; near: number; far: number };

export type Sink = {
  put(name: string, model: Mat4, tint?: Vec3, glow?: number, fog?: number, material?: number, shaded?: number): void;
  cube(parent: Mat4 | null, x: number, y: number, z: number, size: number, r: number, g: number, b: number, glow?: number, fog?: number): void;
  spark(x: number, y: number, z: number, size: number, r: number, g: number, b: number, glow: number): void;
  light(x: number, y: number, z: number, radius: number, r: number, g: number, b: number): void;
};

export type World = {
  meshes: Record<string, { mesh: Mesh; caster?: boolean }>;
  at(t: number, sink: Sink, aspect: number): { cam: Cam; env: Env };
};

export type Job = { world: string; width: number; height: number; samples: number; fps: number; times: number[]; shutter: number };

const SHADOW_SIZE = 2048;
const BLOOM_LEVELS = 7;

function halton(index: number, base: number) {
  let f = 1;
  let r = 0;
  for (let i = index; i > 0; i = Math.floor(i / base)) {
    f /= base;
    r += f * (i % base);
  }
  return r;
}

function lookUp(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

function lightMatrix(center: Vec3, dir: Vec3, radius: number): Mat4 {
  const up: Vec3 = Math.abs(dir[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
  const far = radius * 4;
  const eye: Vec3 = [center[0] + dir[0] * far * 0.5, center[1] + dir[1] * far * 0.5, center[2] + dir[2] * far * 0.5];
  return chain(ortho(radius, 1, far), lookUp(eye, center, up));
}

export function createStage(canvas: HTMLCanvasElement, job: Job, world: World) {
  const { width, height } = job;
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  if (!gl) throw new Error("没有 WebGL2");
  for (const name of ["EXT_color_buffer_float", "EXT_float_blend", "OES_texture_float_linear"]) {
    if (!gl.getExtension(name)) throw new Error(`缺扩展 ${name}`);
  }
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  // hyperframes 的 assertSwiftShader 反过来用：掉到软件渲染就别跑了，慢五十倍。
  if (/swiftshader|llvmpipe/i.test(renderer)) throw new Error(`掉到了软件渲染：${renderer}`);

  const parts: Record<string, Part> = {};
  for (const [name, { mesh, caster }] of Object.entries(world.meshes)) parts[name] = upload(gl, mesh, caster ?? true);
  const list = Object.values(parts);

  const meshes = program(gl, shaders.MESH_VERTEX, shaders.MESH_FRAGMENT);
  const shadow = program(gl, shaders.SHADOW_VERTEX, shaders.SHADOW_FRAGMENT);
  const sky = program(gl, shaders.SKY_VERTEX, shaders.SKY_FRAGMENT);
  const stars = program(gl, shaders.STAR_VERTEX, shaders.STAR_FRAGMENT);
  const add = program(gl, shaders.ADD_VERTEX, shaders.ADD_FRAGMENT);
  const down = program(gl, shaders.DOWN_VERTEX, shaders.DOWN_FRAGMENT);
  const up = program(gl, shaders.UP_VERTEX, shaders.UP_FRAGMENT);
  const final = program(gl, shaders.FINAL_VERTEX, shaders.FINAL_FRAGMENT);

  const hdr = colorTarget(gl, width, height, gl.RGBA16F, true);
  const sum = colorTarget(gl, width, height, gl.RGBA32F);
  const bloom: Target[] = [];
  for (let level = 0; level < BLOOM_LEVELS; level++) {
    const w = Math.max(2, width >> (level + 1));
    const h = Math.max(2, height >> (level + 1));
    bloom.push(colorTarget(gl, w, h, gl.RGBA16F));
  }
  const keyMap = shadowTarget(gl, SHADOW_SIZE);
  const domeMap = shadowTarget(gl, SHADOW_SIZE);
  const empty = gl.createVertexArray();

  const STAR_COUNT = 2600;
  const starData = new Float32Array(STAR_COUNT * 4);
  let seed = 5;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let index = 0; index < STAR_COUNT; index++) {
    const yaw = next() * Math.PI * 2;
    const pitch = Math.asin(next() * 1.1 - 0.1);
    starData.set([Math.sin(yaw) * Math.cos(pitch) * 3000, Math.sin(pitch) * 3000, -Math.cos(yaw) * Math.cos(pitch) * 3000, next()], index * 4);
  }
  const starVao = gl.createVertexArray();
  gl.bindVertexArray(starVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, starData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const lightAt = new Float32Array(shaders.MAX_LIGHTS * 4);
  const lightColor = new Float32Array(shaders.MAX_LIGHTS * 4);
  let lightCount = 0;

  function write(part: Part, m0: number, m1: number, m2: number, m3: number, m4: number, m5: number, m6: number, m7: number, m8: number, m9: number, m10: number, m11: number, m12: number, m13: number, m14: number, m15: number, r: number, g: number, b: number, glow: number, fog: number, material: number, shaded: number) {
    reserve(part, 1);
    const d = part.data;
    const o = part.used * INSTANCE_FLOATS;
    d[o] = m0; d[o + 1] = m1; d[o + 2] = m2; d[o + 3] = m3;
    d[o + 4] = m4; d[o + 5] = m5; d[o + 6] = m6; d[o + 7] = m7;
    d[o + 8] = m8; d[o + 9] = m9; d[o + 10] = m10; d[o + 11] = m11;
    d[o + 12] = m12; d[o + 13] = m13; d[o + 14] = m14; d[o + 15] = m15;
    d[o + 16] = r; d[o + 17] = g; d[o + 18] = b; d[o + 19] = glow;
    d[o + 20] = fog; d[o + 21] = material; d[o + 22] = shaded; d[o + 23] = 0;
    part.used += 1;
  }

  const sink: Sink = {
    put(name, m, tint = [1, 1, 1], glow = 0, fog = 1, material = 0, shaded = 1) {
      const part = parts[name];
      if (!part) throw new Error(`没有模型 ${name}`);
      write(part, m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7]!, m[8]!, m[9]!, m[10]!, m[11]!, m[12]!, m[13]!, m[14]!, m[15]!, tint[0], tint[1], tint[2], glow, fog, material, shaded);
    },
    cube(p, x, y, z, s, r, g, b, glow = 0, fog = 1) {
      const part = parts.cube!;
      if (!p) return write(part, s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1, r, g, b, glow, fog, 0, 1);
      write(
        part,
        p[0]! * s, p[1]! * s, p[2]! * s, 0,
        p[4]! * s, p[5]! * s, p[6]! * s, 0,
        p[8]! * s, p[9]! * s, p[10]! * s, 0,
        p[0]! * x + p[4]! * y + p[8]! * z + p[12]!,
        p[1]! * x + p[5]! * y + p[9]! * z + p[13]!,
        p[2]! * x + p[6]! * y + p[10]! * z + p[14]!,
        1, r, g, b, glow, fog, 0, 1
      );
    },
    spark(x, y, z, s, r, g, b, glow) {
      write(parts.spark!, s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1, r, g, b, glow, 0.35, 2, 0);
    },
    light(x, y, z, radius, r, g, b) {
      if (lightCount >= shaders.MAX_LIGHTS) return;
      lightAt.set([x, y, z, radius], lightCount * 4);
      lightColor.set([r, g, b, 0], lightCount * 4);
      lightCount += 1;
    }
  };

  function drawParts(onlyCasters: boolean) {
    for (const part of list) {
      if (part.used === 0 || (onlyCasters && !part.caster)) continue;
      gl!.bindVertexArray(part.vao);
      gl!.drawArraysInstanced(gl!.TRIANGLES, 0, part.count, part.used);
    }
  }

  function shadowPass(target: { framebuffer: WebGLFramebuffer }, matrix: Mat4) {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, target.framebuffer);
    gl!.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl!.clear(gl!.DEPTH_BUFFER_BIT);
    gl!.uniformMatrix4fv(shadow.at("uLight"), false, matrix);
    drawParts(true);
  }

  function setSky(p: ReturnType<typeof program>, env: Env) {
    gl!.uniform3fv(p.at("uSkyTop"), env.top);
    gl!.uniform3fv(p.at("uSkyMid"), env.mid);
    gl!.uniform3fv(p.at("uSkyLow"), env.low);
    gl!.uniform3fv(p.at("uSkyBelow"), env.below);
    gl!.uniform3fv(p.at("uGlowDir"), env.glowDir);
    gl!.uniform3fv(p.at("uGlowColor"), env.glowColor);
  }

  function skyAt(env: Env, ray: Vec3): Vec3 {
    const mix = (a: Vec3, b: Vec3, k: number): Vec3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const smooth = (a: number, b: number, x: number) => {
      const c = Math.min(Math.max((x - a) / (b - a), 0), 1);
      return c * c * (3 - 2 * c);
    };
    let color = mix(env.low, env.mid, smooth(0, 0.2, ray[1]));
    color = mix(color, env.top, smooth(0.14, 0.75, ray[1]));
    return color;
  }

  function subframe(t: number, index: number, frameEnv: { last?: Env }) {
    lightCount = 0;
    for (const part of list) part.used = 0;
    const { cam, env } = world.at(t, sink, width / height);
    frameEnv.last = env;

    for (const part of list) {
      if (part.used === 0) continue;
      gl!.bindBuffer(gl!.ARRAY_BUFFER, part.instances);
      gl!.bufferData(gl!.ARRAY_BUFFER, part.data.subarray(0, part.used * INSTANCE_FLOATS), gl!.DYNAMIC_DRAW);
    }

    const h = index + 1;
    const forward = normalize([cam.target[0] - cam.eye[0], cam.target[1] - cam.eye[1], cam.target[2] - cam.eye[2]]);
    const right = normalize(cross(forward, [0, 1, 0]));
    const upward = cross(right, forward);
    const radius = Math.sqrt(halton(h, 5)) * cam.aperture;
    const angle = halton(h, 7) * Math.PI * 2;
    const lensX = Math.cos(angle) * radius;
    const lensY = Math.sin(angle) * radius;
    const eye: Vec3 = [0, 1, 2].map((a) => cam.eye[a]! + right[a]! * lensX + upward[a]! * lensY) as Vec3;
    const focus: Vec3 = [0, 1, 2].map((a) => cam.eye[a]! + forward[a]! * cam.focus) as Vec3;

    const projection = perspective(cam.fov, width / height, cam.near, cam.far);
    projection[8] = ((halton(h, 2) - 0.5) * 2) / width;
    projection[9] = ((halton(h, 3) - 0.5) * 2) / height;
    const viewProjection = chain(projection, rotateZ(cam.roll), lookAt(eye, focus));
    const starView = chain(projection, rotateZ(cam.roll), lookAt(cam.eye, focus));

    const spreadA = halton(h, 11) * Math.PI * 2;
    const spreadR = Math.sqrt(halton(h, 13)) * env.keySpread;
    const side = normalize(cross(env.keyDir, [0.3, 1, 0.2]));
    const lift = cross(env.keyDir, side);
    const keyDir = normalize([0, 1, 2].map((a) => env.keyDir[a]! + side[a]! * Math.cos(spreadA) * spreadR + lift[a]! * Math.sin(spreadA) * spreadR) as Vec3);

    const u = halton(h, 17);
    const phi = halton(h, 19) * Math.PI * 2;
    const sinTheta = Math.sqrt(u);
    const domeDir: Vec3 = [Math.cos(phi) * sinTheta, Math.sqrt(1 - u), Math.sin(phi) * sinTheta];
    const domeSky = skyAt(env, domeDir);
    const domeColor: Vec3 = [domeSky[0] * env.domeGain, domeSky[1] * env.domeGain, domeSky[2] * env.domeGain];

    const keyMatrix = lightMatrix(env.shadowCenter, keyDir, env.shadowRadius);
    const domeMatrix = lightMatrix(env.shadowCenter, domeDir, env.shadowRadius);

    gl!.disable(gl!.BLEND);
    gl!.enable(gl!.DEPTH_TEST);
    gl!.depthMask(true);
    gl!.colorMask(false, false, false, false);
    shadow.use();
    shadowPass(keyMap, keyMatrix);
    shadowPass(domeMap, domeMatrix);
    gl!.colorMask(true, true, true, true);

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, hdr.framebuffer);
    gl!.viewport(0, 0, width, height);
    gl!.clear(gl!.DEPTH_BUFFER_BIT);

    gl!.disable(gl!.DEPTH_TEST);
    sky.use();
    gl!.uniformMatrix4fv(sky.at("uInverse"), false, invert(viewProjection));
    gl!.uniform3fv(sky.at("uEye"), eye);
    setSky(sky, env);
    gl!.bindVertexArray(empty);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    if (env.stars > 0.002) {
      gl!.enable(gl!.BLEND);
      gl!.blendFunc(gl!.ONE, gl!.ONE);
      stars.use();
      gl!.uniformMatrix4fv(stars.at("uViewProjection"), false, starView);
      gl!.uniform3fv(stars.at("uEye"), cam.eye);
      gl!.uniform1f(stars.at("uTime"), t);
      gl!.uniform1f(stars.at("uAmount"), env.stars);
      gl!.uniform1f(stars.at("uSize"), Math.max(1.3, height / 760));
      gl!.bindVertexArray(starVao);
      gl!.drawArrays(gl!.POINTS, 0, STAR_COUNT);
      gl!.disable(gl!.BLEND);
    }

    gl!.enable(gl!.DEPTH_TEST);
    meshes.use();
    gl!.uniformMatrix4fv(meshes.at("uViewProjection"), false, viewProjection);
    gl!.uniformMatrix4fv(meshes.at("uKeyMatrix"), false, keyMatrix);
    gl!.uniformMatrix4fv(meshes.at("uDomeMatrix"), false, domeMatrix);
    gl!.uniform3fv(meshes.at("uKeyDir"), keyDir);
    gl!.uniform3fv(meshes.at("uKeyColor"), env.keyColor);
    gl!.uniform3fv(meshes.at("uDomeDir"), domeDir);
    gl!.uniform3fv(meshes.at("uDomeColor"), domeColor);
    gl!.uniform3fv(meshes.at("uAmbient"), env.ambient);
    gl!.uniform3fv(meshes.at("uRimDir"), env.rimDir);
    gl!.uniform3fv(meshes.at("uRimColor"), env.rimColor);
    gl!.uniform3fv(meshes.at("uEye"), eye);
    gl!.uniform3fv(meshes.at("uFog"), env.fog);
    gl!.uniform1f(meshes.at("uTexel"), (env.shadowRadius * 2) / SHADOW_SIZE);
    gl!.uniform1i(meshes.at("uLightCount"), lightCount);
    gl!.uniform4fv(meshes.at("uLightAt"), lightAt);
    gl!.uniform4fv(meshes.at("uLightColor"), lightColor);
    setSky(meshes, env);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, keyMap.texture);
    gl!.uniform1i(meshes.at("uKeyMap"), 0);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, domeMap.texture);
    gl!.uniform1i(meshes.at("uDomeMap"), 1);
    drawParts(false);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, null);

    gl!.disable(gl!.DEPTH_TEST);
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, sum.framebuffer);
    gl!.viewport(0, 0, width, height);
    gl!.enable(gl!.BLEND);
    gl!.blendFunc(gl!.ONE, gl!.ONE);
    add.use();
    gl!.bindTexture(gl!.TEXTURE_2D, hdr.texture);
    gl!.uniform1i(add.at("uImage"), 0);
    gl!.uniform1f(add.at("uWeight"), 1 / job.samples);
    gl!.bindVertexArray(empty);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    gl!.disable(gl!.BLEND);
  }

  function runBloom() {
    down.use();
    gl!.uniform1i(down.at("uImage"), 0);
    gl!.bindVertexArray(empty);
    let source: Target = sum;
    bloom.forEach((target, level) => {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, target.framebuffer);
      gl!.viewport(0, 0, target.width, target.height);
      gl!.bindTexture(gl!.TEXTURE_2D, source.texture);
      gl!.uniform2f(down.at("uTexel"), 1 / source.width, 1 / source.height);
      gl!.uniform1f(down.at("uThreshold"), level === 0 ? 0.9 : 0);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
      source = target;
    });
    up.use();
    gl!.uniform1i(up.at("uImage"), 0);
    gl!.uniform1f(up.at("uSpread"), 1);
    gl!.enable(gl!.BLEND);
    gl!.blendFunc(gl!.ONE, gl!.ONE);
    for (let level = BLOOM_LEVELS - 1; level > 0; level--) {
      const from = bloom[level]!;
      const to = bloom[level - 1]!;
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, to.framebuffer);
      gl!.viewport(0, 0, to.width, to.height);
      gl!.bindTexture(gl!.TEXTURE_2D, from.texture);
      gl!.uniform2f(up.at("uTexel"), 1 / from.width, 1 / from.height);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    }
    gl!.disable(gl!.BLEND);
  }

  const pixels = [new Uint8Array(width * height * 4), new Uint8Array(width * height * 4)];
  let flip = 0;

  function frame(t: number): Uint8Array {
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, sum.framebuffer);
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    const holder: { last?: Env } = {};
    const open = job.shutter / job.fps;
    for (let index = 0; index < job.samples; index++) {
      const slot = (index * 0.6180339887 + 0.5) % 1;
      subframe(t + (slot - 0.5) * open, index, holder);
    }
    runBloom();
    const env = holder.last!;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, width, height);
    final.use();
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, sum.texture);
    gl!.uniform1i(final.at("uImage"), 0);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, bloom[0]!.texture);
    gl!.uniform1i(final.at("uBloom"), 1);
    gl!.uniform1f(final.at("uExposure"), env.exposure);
    gl!.uniform1f(final.at("uBloomAmount"), env.bloom);
    gl!.uniform1f(final.at("uVignette"), env.vignette);
    gl!.uniform1f(final.at("uGrain"), 0.012);
    gl!.uniform1f(final.at("uTime"), t);
    gl!.uniform1f(final.at("uAberration"), 0.0011);
    gl!.uniform1f(final.at("uFade"), env.fade);
    gl!.uniform3fv(final.at("uFlash"), env.flash);
    gl!.uniform3fv(final.at("uLift"), [0.008, 0.01, 0.018]);
    gl!.uniform3fv(final.at("uGain"), [1, 1, 1]);
    gl!.bindVertexArray(empty);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    gl!.activeTexture(gl!.TEXTURE1);
    gl!.bindTexture(gl!.TEXTURE_2D, null);
    gl!.activeTexture(gl!.TEXTURE0);
    const out = pixels[flip]!;
    flip = 1 - flip;
    gl!.readPixels(0, 0, width, height, gl!.RGBA, gl!.UNSIGNED_BYTE, out);
    return out;
  }

  return { frame, renderer };
}
