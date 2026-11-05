/**
 * 登录页左边的 3D 场景：体素 Pupu 扒在大气泡上，夜空、月亮、云海，远处的小气泡之间有光点流动。
 * 网页的登录页和电脑 App 的配对窗口用的都是这一份。模型在 pupu-voxels.ts。
 *
 * 画布按设备像素开、跟着 ResizeObserver 走，来自 pixel-agents 的 OfficeCanvas.tsx。
 * 没有 WebGL2 时什么都不画，露出 CSS 上的静态头像。
 */
import {
  BUBBLE_FRONT,
  VERTEX_FLOATS,
  bodyGrid,
  bubbleGrid,
  cloudGrid,
  cubeGrid,
  dotGrid,
  earGrid,
  headGrid,
  mesh,
  moonGrid,
  pawsGrid,
  type Eyes,
  type Mesh
} from "./pupu-voxels";
import {
  CENTER,
  FAR_BUBBLES,
  MOON_SIZE,
  camera,
  chain,
  invert,
  normalize,
  ortho,
  lookAt,
  rotateX,
  rotateY,
  rotateZ,
  scale,
  translate,
  type Mat4,
  type Vec3
} from "./pupu-camera";

/*
 * 节奏都在这里，单位是秒。一轮 LOOP 秒，之后从头再来。
 */
const LOOP = 24;
const BLINKS = [3.4, 11.8, 12.3, 20.4]; // 11.8、12.3 连着，是眨两下
const GLANCE = { from: 6.6, to: 8.8 }; // 转头瞄一眼右边的登录按钮
const EAR_FLICKS = [15.6, 16]; // 右耳抖两下
const BREATH = 4; // 一呼一吸
const DOT_WAVE = 2; // 三个点走一遍
const STILL_AT = 2; // 减弱动态效果时停在这一刻
const FRAME_MS = 1000 / 30; // 不跟屏幕刷新率走：大窗口每帧 GPU 约 3.6 毫秒（M3），120Hz 屏跑满要占四成

const MAX_PIXEL_RATIO = 2;
const SHADOW_SIZE = 1024;

const KEY_LIGHT = normalize([-0.45, 0.7, 0.75]);
const FOG_COLOR = [0.085, 0.13, 0.21];

const MESH_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec2 aShade;
uniform mat4 uViewProjection, uModel, uLight;
out vec3 vWorld, vNormal, vColor;
out vec2 vShade;
out vec4 vLight;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vShade = aShade;
  vLight = uLight * world;
  gl_Position = uViewProjection * world;
}`;

const MESH_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vWorld, vNormal, vColor;
in vec2 vShade;
in vec4 vLight;
uniform sampler2DShadow uShadow;
uniform vec3 uKey, uCamera, uFogColor, uTint;
uniform float uGlow, uFog, uShaded;
out vec4 outColor;
float lit() {
  vec3 p = vLight.xyz * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    sum += texture(uShadow, vec3(p.xy + vec2(x, y) / ${SHADOW_SIZE}.0, p.z - 0.0016));
  }
  return sum / 9.0;
}
void main() {
  vec3 n = normalize(vNormal);
  float up = n.y * 0.5 + 0.5;
  vec3 ambient = mix(vec3(0.3, 0.27, 0.3), vec3(0.38, 0.45, 0.62), up);
  float key = max(dot(n, uKey), 0.0) * mix(1.0, lit(), uShaded);
  float rim = max(dot(n, normalize(vec3(0.5, 0.35, -0.8))), 0.0);
  vec3 light = ambient * vShade.x + vec3(1.0, 0.95, 0.86) * key * 0.74 * mix(0.75, 1.0, vShade.x) + vec3(0.45, 0.58, 0.85) * rim * 0.3;
  vec3 color = vColor * uTint;
  vec3 result = color * light + color * (vShade.y + uGlow);
  float far = max(distance(vWorld, uCamera) - 110.0, 0.0);
  float fog = (1.0 - exp(-far * 0.006)) * uFog;
  outColor = vec4(mix(result, uFogColor, fog), 1.0);
}`;

const SHADOW_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
uniform mat4 uLight, uModel;
void main() { gl_Position = uLight * uModel * vec4(aPosition, 1.0); }`;

const SHADOW_FRAGMENT = `#version 300 es
precision mediump float;
void main() {}`;

const SKY_VERTEX = `#version 300 es
out vec2 vClip;
void main() {
  vClip = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(vClip, 1.0, 1.0);
}`;

const SKY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vClip;
uniform mat4 uInverse;
uniform vec3 uCamera, uMoon;
out vec4 outColor;
void main() {
  vec4 far = uInverse * vec4(vClip, 1.0, 1.0);
  vec3 ray = normalize(far.xyz / far.w - uCamera);
  float h = clamp(ray.y * 2.4 + 0.42, 0.0, 1.0);
  vec3 color = mix(vec3(0.114, 0.15, 0.2), vec3(0.082, 0.137, 0.227), smoothstep(0.0, 0.5, h));
  color = mix(color, vec3(0.047, 0.078, 0.125), smoothstep(0.45, 1.0, h));
  float moon = max(dot(ray, uMoon), 0.0);
  color += vec3(0.5, 0.56, 0.68) * (pow(moon, 180.0) * 0.32 + pow(moon, 18.0) * 0.1);
  float noise = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  outColor = vec4(color + (noise - 0.5) / 255.0, 1.0);
}`;

const STAR_VERTEX = `#version 300 es
layout(location=0) in vec4 aStar;
uniform mat4 uViewProjection;
uniform float uTime, uSize;
out float vBright;
void main() {
  gl_Position = uViewProjection * vec4(aStar.xyz, 1.0);
  float twinkle = 0.55 + 0.45 * sin(uTime * (0.4 + aStar.w * 0.9) + aStar.w * 40.0);
  vBright = twinkle * (0.35 + aStar.w * 0.65);
  gl_PointSize = uSize * (aStar.w > 0.82 ? 2.0 : 1.0);
}`;

const STAR_FRAGMENT = `#version 300 es
precision mediump float;
in float vBright;
out vec4 outColor;
void main() { outColor = vec4(vec3(0.9, 0.93, 1.0) * vBright, vBright); }`;

function program(gl: WebGL2RenderingContext, vertex: string, fragment: string) {
  const made = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment]
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
    gl.attachShader(made, shader);
  }
  gl.linkProgram(made);
  if (!gl.getProgramParameter(made, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(made) ?? "program");
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  return {
    use: () => gl.useProgram(made),
    at(name: string) {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(made, name));
      return uniforms.get(name)!;
    }
  };
}

type Drawable = { vao: WebGLVertexArrayObject; count: number };

function upload(gl: WebGL2RenderingContext, data: Mesh): Drawable {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
  const stride = VERTEX_FLOATS * 4;
  [3, 3, 3, 2].reduce((offset, size, index) => {
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset * 4);
    return offset + size;
  }, 0);
  gl.bindVertexArray(null);
  return { vao, count: data.count };
}

/** from 到 to 之间升到 1 再落回去，两头各用 ramp 秒。 */
function bump(t: number, from: number, to: number, ramp: number) {
  const smooth = (x: number) => {
    const c = Math.min(Math.max(x, 0), 1);
    return c * c * (3 - 2 * c);
  };
  return smooth((t - from) / ramp) * (1 - smooth((t - to + ramp) / ramp));
}

export function eyesAt(t: number): Eyes {
  const time = t % LOOP;
  for (const start of BLINKS) {
    const step = time - start;
    if (step >= 0.09 && step < 0.18) return "closed";
    if (step >= 0 && step < 0.27) return "half";
  }
  return time >= GLANCE.from + 0.3 && time < GLANCE.to - 0.2 ? "right" : "open";
}

const HEAD_PIVOT: Vec3 = [12, 11, -5];
const EAR_LEFT_PIVOT: Vec3 = [7, 20, -3];
const EAR_RIGHT_PIVOT: Vec3 = [17, 20, -3];
const DOT_COLUMNS = [8, 11, 14];

const CLOUDS: { seed: number; at: Vec3; speed: number; size: number }[] = [
  { seed: 7, at: [-30, -9, 2], speed: 0.45, size: 0.8 },
  { seed: 15, at: [-10, -16, 22], speed: 0.6, size: 0.9 },
  { seed: 21, at: [44, -12, -30], speed: 0.36, size: 1.3 },
  { seed: 33, at: [-70, -20, -66], speed: 0.28, size: 1.9 },
  { seed: 48, at: [80, -24, -110], speed: 0.22, size: 2.4 },
  { seed: 59, at: [10, -30, -150], speed: 0.16, size: 3 },
  { seed: 72, at: [-90, -6, -220], speed: 0.1, size: 3 }
];
const CLOUD_RANGE = 170;

/** 光点的路线：下标是 FAR_BUBBLES，-1 是大气泡。 */
const FLOWS: [number, number][] = [
  [0, -1],
  [-1, 1],
  [2, -1],
  [-1, 3],
  [0, 2],
  [3, 1]
];
const FLOW_SECONDS = 9;

function scene(gl: WebGL2RenderingContext) {
  const heads = Object.fromEntries((["open", "half", "closed", "right"] as const).map((eyes) => [eyes, upload(gl, mesh(headGrid(eyes), HEAD_PIVOT))])) as Record<Eyes, Drawable>;
  const earLeft = upload(gl, mesh(earGrid("left"), EAR_LEFT_PIVOT));
  const earRight = upload(gl, mesh(earGrid("right"), EAR_RIGHT_PIVOT));
  const bubble = upload(gl, mesh(bubbleGrid()));
  const dot = upload(gl, mesh(dotGrid()));
  const paws = upload(gl, mesh(pawsGrid()));
  const body = upload(gl, mesh(bodyGrid()));
  const furCube = upload(gl, mesh(cubeGrid("g"), [0.5, 0.5, 0.5]));
  const darkCube = upload(gl, mesh(cubeGrid("D"), [0.5, 0.5, 0.5]));
  const lightCube = upload(gl, mesh(cubeGrid("c"), [0.5, 0.5, 0.5]));
  const moon = upload(gl, mesh(moonGrid()));
  const clouds = CLOUDS.map((cloud) => upload(gl, mesh(cloudGrid(cloud.seed))));

  const meshes = program(gl, MESH_VERTEX, MESH_FRAGMENT);
  const shadows = program(gl, SHADOW_VERTEX, SHADOW_FRAGMENT);
  const sky = program(gl, SKY_VERTEX, SKY_FRAGMENT);
  const stars = program(gl, STAR_VERTEX, STAR_FRAGMENT);

  const shadowMap = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, shadowMap);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const shadowTarget = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTarget);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowMap, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const starData = new Float32Array(260 * 4);
  let seed = 5;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let index = 0; index < 260; index++) {
    const yaw = 0.33 + (next() - 0.5) * 1;
    const pitch = next() * 0.45 - 0.1;
    starData.set([Math.sin(yaw) * Math.cos(pitch) * 400, Math.sin(pitch) * 400, -Math.cos(yaw) * Math.cos(pitch) * 400, next()], index * 4);
  }
  const starVao = gl.createVertexArray();
  gl.bindVertexArray(starVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, starData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const emptyVao = gl.createVertexArray();

  const lightView = chain(ortho(34, 1, 140), lookAt([CENTER[0] + KEY_LIGHT[0] * 70, CENTER[1] + KEY_LIGHT[1] * 70, CENTER[2] + KEY_LIGHT[2] * 70], CENTER));

  /** 这一刻所有东西摆在哪。 */
  function pose(t: number) {
    const time = t % LOOP;
    const breath = Math.sin((t / BREATH) * Math.PI * 2);
    const root = chain(translate(0, Math.sin((t / 8) * Math.PI * 2) * 0.35, 0), rotateZ(Math.sin((t / 12) * Math.PI * 2) * 0.008));
    const glance = bump(time, GLANCE.from, GLANCE.to, 0.5);
    const head = chain(
      root,
      translate(HEAD_PIVOT[0], HEAD_PIVOT[1] + breath * 0.14, HEAD_PIVOT[2]),
      rotateY(glance * 0.2 + Math.sin((t / 12) * Math.PI * 2) * 0.03),
      rotateX(breath * 0.012 + glance * 0.02)
    );
    const flick = EAR_FLICKS.reduce((sum, start) => sum + bump(time, start, start + 0.22, 0.08), 0);
    const from = (pivot: Vec3) => translate(pivot[0] - HEAD_PIVOT[0], pivot[1] - HEAD_PIVOT[1], pivot[2] - HEAD_PIVOT[2]);
    const solid: [Drawable, Mat4][] = [
      [bubble, root],
      [paws, root],
      [body, chain(root, translate(0, breath * 0.08, 0))],
      [heads[eyesAt(t)], head],
      [earLeft, chain(head, from(EAR_LEFT_PIVOT))],
      [earRight, chain(head, from(EAR_RIGHT_PIVOT), rotateZ(-flick * 0.24))]
    ];
    DOT_COLUMNS.forEach((column, index) => {
      const phase = (t / DOT_WAVE - index * 0.16 + 10) % 1;
      const pop = bump(phase, 0, 0.42, 0.2);
      solid.push([dot, chain(root, translate(column, 5, BUBBLE_FRONT - 0.6 + pop * 0.85))]);
    });
    for (let index = 0; index < 11; index++) {
      const swing = Math.sin((t / 5) * Math.PI * 2 - index * 0.42) * index * 0.1;
      const part = index === 10 ? lightCube : index % 4 === 3 ? darkCube : furCube;
      solid.push([part, chain(root, translate(8 - index * 1 + swing, 7 + index * index * 0.09, -9), scale(2.3 - index * 0.03))]);
    }
    return { root, solid };
  }

  function render(t: number, width: number, height: number) {
    const { root, solid } = pose(t);

    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowTarget);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.colorMask(false, false, false, false);
    shadows.use();
    gl.uniformMatrix4fv(shadows.at("uLight"), false, lightView);
    for (const [part, model] of solid) {
      gl.uniformMatrix4fv(shadows.at("uModel"), false, model);
      gl.bindVertexArray(part.vao);
      gl.drawArrays(gl.TRIANGLES, 0, part.count);
    }
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.viewport(0, 0, width, height);
    const { eye, viewProjection, moonAt, farAt } = camera(t, width / height);

    gl.disable(gl.DEPTH_TEST);
    sky.use();
    gl.uniformMatrix4fv(sky.at("uInverse"), false, invert(viewProjection));
    gl.uniform3fv(sky.at("uCamera"), eye);
    gl.uniform3fv(sky.at("uMoon"), normalize([moonAt[0] - eye[0], moonAt[1] - eye[1], moonAt[2] - eye[2]]));
    gl.bindVertexArray(emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    stars.use();
    gl.uniformMatrix4fv(stars.at("uViewProjection"), false, viewProjection);
    gl.uniform1f(stars.at("uTime"), t);
    gl.uniform1f(stars.at("uSize"), Math.max(1.5, height / 420));
    gl.bindVertexArray(starVao);
    gl.drawArrays(gl.POINTS, 0, 260);
    gl.disable(gl.BLEND);

    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    meshes.use();
    gl.uniformMatrix4fv(meshes.at("uViewProjection"), false, viewProjection);
    gl.uniformMatrix4fv(meshes.at("uLight"), false, lightView);
    gl.uniform3fv(meshes.at("uKey"), KEY_LIGHT);
    gl.uniform3fv(meshes.at("uCamera"), eye);
    gl.uniform3fv(meshes.at("uFogColor"), FOG_COLOR);
    gl.uniform1i(meshes.at("uShadow"), 0);

    const draw = (part: Drawable, model: Mat4, tint: Vec3 = [1, 1, 1], glow = 0, fog = 1, shaded = 0) => {
      gl.uniformMatrix4fv(meshes.at("uModel"), false, model);
      gl.uniform3fv(meshes.at("uTint"), tint);
      gl.uniform1f(meshes.at("uGlow"), glow);
      gl.uniform1f(meshes.at("uFog"), fog);
      gl.uniform1f(meshes.at("uShaded"), shaded);
      gl.bindVertexArray(part.vao);
      gl.drawArrays(gl.TRIANGLES, 0, part.count);
    };

    draw(moon, chain(translate(...moonAt), rotateY(0.33), scale(MOON_SIZE)), [0.78, 0.78, 0.74], 0.45, 0, 0);
    for (const [part, model] of solid) draw(part, model, [1, 1, 1], 0, 1, 1);

    const farModels = FAR_BUBBLES.map(({ size, phase }, index) => {
      const at = farAt[index]!;
      return chain(translate(at[0], at[1] + Math.sin(t * 0.5 + phase) * 1.2, at[2]), rotateY(0.3 - phase * 0.1), scale(size), translate(-12, -6, 0));
    });
    FAR_BUBBLES.forEach((_, index) => {
      draw(bubble, farModels[index]!);
      DOT_COLUMNS.forEach((column) => draw(dot, chain(farModels[index]!, translate(column, 5, BUBBLE_FRONT - 0.5))));
    });

    CLOUDS.forEach((cloud, index) => {
      const x = ((cloud.at[0] + t * cloud.speed + CLOUD_RANGE) % (CLOUD_RANGE * 2)) - CLOUD_RANGE;
      draw(clouds[index]!, chain(translate(x, cloud.at[1], cloud.at[2]), scale(cloud.size)));
    });

    const anchor = (index: number): Vec3 => {
      if (index < 0) return [root[12]! + 12, root[13]! + 6, BUBBLE_FRONT - 4];
      return farAt[index]!;
    };
    FLOWS.forEach(([start, end], index) => {
      const a = anchor(start);
      const b = anchor(end);
      const mid: Vec3 = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + 18, (a[2] + b[2]) / 2];
      for (let trail = 0; trail < 4; trail++) {
        const p = (t / FLOW_SECONDS + index / FLOWS.length - trail * 0.012 + 1) % 1;
        const q = 1 - p;
        const size = Math.sin(p * Math.PI) ** 0.5 * (1.3 - trail * 0.26);
        draw(
          lightCube,
          chain(translate(q * q * a[0] + 2 * p * q * mid[0] + p * p * b[0], q * q * a[1] + 2 * p * q * mid[1] + p * p * b[1], q * q * a[2] + 2 * p * q * mid[2] + p * p * b[2]), scale(size)),
          [1, 0.82, 0.52],
          1.1 - trail * 0.2,
          0.4
        );
      }
    });
    gl.bindVertexArray(null);
  }

  return render;
}

/**
 * 让画布动起来，返回停下的函数。第一次露出来才建场景，窄窗口里画布是隐藏的，什么都不跑。
 * 减弱动态效果时停在一帧；页面不可见或画布隐藏时不走，回来接着走。
 */
export function mountPupuArt(canvas: HTMLCanvasElement): () => void {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
  let render: ReturnType<typeof scene> | null = null;
  let broken = false;
  let frame = 0;
  let time = 0;
  let last = 0;

  function paint() {
    const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    render?.(calm.matches ? STILL_AT : time, width, height);
  }

  function step(now: number) {
    frame = requestAnimationFrame(step);
    const elapsed = now - last;
    if (elapsed < FRAME_MS) return;
    time += Math.min(elapsed / 1000, 0.1);
    last = now - (elapsed % FRAME_MS);
    paint();
  }

  function sync() {
    const shown = canvas.clientWidth > 0 && !document.hidden;
    if (shown && !render && !broken) {
      const gl = canvas.getContext("webgl2", { alpha: false, antialias: true, powerPreference: "low-power" });
      if (gl) render = scene(gl);
      else broken = true;
    }
    const running = shown && render !== null && !calm.matches;
    if (running && !frame) {
      last = performance.now();
      frame = requestAnimationFrame(step);
    } else if (!running && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (shown && !running) paint();
  }

  function lost() {
    broken = true;
    render = null;
    canvas.hidden = true;
    sync();
  }

  const resized = new ResizeObserver(() => {
    sync();
    if (canvas.clientWidth > 0 && frame) paint();
  });
  resized.observe(canvas);
  calm.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  canvas.addEventListener("webglcontextlost", lost);
  sync();

  return () => {
    resized.disconnect();
    calm.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    canvas.removeEventListener("webglcontextlost", lost);
    if (frame) cancelAnimationFrame(frame);
  };
}
