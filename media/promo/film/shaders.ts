/**
 * 片子的着色器。光照在线性空间算，末尾才做色调映射，所以光能真的把气泡照亮。
 * 模型、颜色和登录页 pupu-art.ts 是一套，这里换成了能累积的高动态版本。
 * 泛光的 13 点下采样和帐篷上采样是 pmndrs/postprocessing 的 MipmapBlurPass 用的做法（Jimenez 2014）。
 */

const SKY = `
uniform vec3 uSkyTop, uSkyMid, uSkyLow, uSkyBelow, uGlowDir, uGlowColor;
vec3 skyColor(vec3 ray) {
  float h = ray.y;
  vec3 color = mix(uSkyLow, uSkyMid, smoothstep(0.0, 0.2, h));
  color = mix(color, uSkyTop, smoothstep(0.14, 0.75, h));
  color = mix(uSkyBelow, color, smoothstep(-0.3, 0.02, h));
  float g = max(dot(ray, uGlowDir), 0.0);
  color += uGlowColor * (pow(g, 700.0) * 0.5 + pow(g, 80.0) * 0.16 + pow(g, 10.0) * 0.05);
  return color;
}`;

export const MESH_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec2 aShade;
layout(location=4) in vec4 iM0;
layout(location=5) in vec4 iM1;
layout(location=6) in vec4 iM2;
layout(location=7) in vec4 iM3;
layout(location=8) in vec4 iTint;
layout(location=9) in vec4 iExtra;
uniform mat4 uViewProjection;
out vec3 vWorld, vNormal, vColor;
out vec2 vShade;
out vec4 vTint, vExtra;
void main() {
  mat4 model = mat4(iM0, iM1, iM2, iM3);
  vec4 world = model * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(model) * aNormal);
  vColor = aColor;
  vShade = aShade;
  vTint = iTint;
  vExtra = iExtra;
  gl_Position = uViewProjection * world;
}`;

export const MAX_LIGHTS = 16;

export const MESH_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2DShadow;
in vec3 vWorld, vNormal, vColor;
in vec2 vShade;
in vec4 vTint, vExtra;
uniform sampler2DShadow uKeyMap, uDomeMap;
uniform mat4 uKeyMatrix, uDomeMatrix;
uniform vec3 uKeyDir, uKeyColor, uDomeDir, uDomeColor, uAmbient, uEye, uRimDir, uRimColor;
uniform vec3 uFog;
uniform float uTexel;
uniform int uLightCount;
uniform vec4 uLightAt[${MAX_LIGHTS}];
uniform vec4 uLightColor[${MAX_LIGHTS}];
${SKY}
out vec4 outColor;

float visible(sampler2DShadow map, mat4 matrix, vec3 world, vec3 normal) {
  vec4 at = matrix * vec4(world + normal * uTexel * 2.0, 1.0);
  vec3 p = at.xyz * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  return texture(map, vec3(p.xy, p.z - 0.0004));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = pow(clamp(vColor * vTint.rgb, 0.0, 1.0), vec3(2.2));
  float ao = vShade.x;
  float material = vExtra.y;
  vec3 light;
  vec3 emit = albedo * (vTint.a + vShade.y * 0.6);

  if (material > 1.5) {
    light = vec3(0.0);
  } else if (material > 0.5) {
    // 云：高度明暗在模型里算好了放在遮蔽那一格。
    float wrap = clamp((dot(n, uKeyDir) + 0.6) / 1.6, 0.0, 1.0);
    float rimWrap = clamp((dot(n, uRimDir) + 0.3) / 1.3, 0.0, 1.0);
    vec3 shade = mix(uSkyBelow * 1.4, uSkyMid * 2.2 + uAmbient * 3.0, ao);
    light = shade + (uKeyColor * wrap * 0.8 + uRimColor * rimWrap * rimWrap) * ao * ao;
  } else {
    float key = max(dot(n, uKeyDir), 0.0) * mix(1.0, visible(uKeyMap, uKeyMatrix, vWorld, n), vExtra.z);
    float dome = max(dot(n, uDomeDir), 0.0) * mix(1.0, visible(uDomeMap, uDomeMatrix, vWorld, n), vExtra.z);
    float rim = max(dot(n, uRimDir), 0.0);
    light = uKeyColor * key * mix(0.8, 1.0, ao) + (uDomeColor * dome + uAmbient) * ao + uRimColor * rim * ao;
  }

  if (material < 1.5) {
    for (int i = 0; i < ${MAX_LIGHTS}; i++) {
      if (i >= uLightCount) break;
      vec3 to = uLightAt[i].xyz - vWorld;
      float d2 = dot(to, to);
      float r = uLightAt[i].w;
      float fall = 1.0 / (1.0 + d2 / (r * r));
      fall *= fall;
      float wrap = clamp((dot(n, to * inversesqrt(d2)) + 0.25) / 1.25, 0.0, 1.0);
      light += uLightColor[i].rgb * fall * wrap;
    }
  }

  vec3 color = albedo * light + emit;

  vec3 path = vWorld - uEye;
  float dist = length(path);
  vec3 ray = path / dist;
  float slope = abs(ray.y) < 1e-3 ? 1e-3 : ray.y;
  float density = uFog.x * exp(-(uEye.y - uFog.y) * uFog.z) * (1.0 - exp(-dist * slope * uFog.z)) / (slope * uFog.z);
  float fog = (1.0 - exp(-max(density, 0.0))) * vExtra.x;
  outColor = vec4(mix(color, skyColor(ray), fog), 1.0);
}`;

export const SHADOW_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=4) in vec4 iM0;
layout(location=5) in vec4 iM1;
layout(location=6) in vec4 iM2;
layout(location=7) in vec4 iM3;
uniform mat4 uLight;
void main() { gl_Position = uLight * mat4(iM0, iM1, iM2, iM3) * vec4(aPosition, 1.0); }`;

export const SHADOW_FRAGMENT = `#version 300 es
precision mediump float;
void main() {}`;

const FULLSCREEN = `#version 300 es
out vec2 vClip;
void main() {
  vClip = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(vClip, 1.0, 1.0);
}`;

export const SKY_VERTEX = FULLSCREEN;

export const SKY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vClip;
uniform mat4 uInverse;
uniform vec3 uEye;
${SKY}
out vec4 outColor;
void main() {
  vec4 far = uInverse * vec4(vClip, 1.0, 1.0);
  vec3 ray = normalize(far.xyz / far.w - uEye);
  outColor = vec4(skyColor(ray), 1.0);
}`;

export const STAR_VERTEX = `#version 300 es
layout(location=0) in vec4 aStar;
uniform mat4 uViewProjection;
uniform vec3 uEye;
uniform float uTime, uSize, uAmount;
out float vBright;
void main() {
  gl_Position = uViewProjection * vec4(uEye + aStar.xyz, 1.0);
  float twinkle = 0.6 + 0.4 * sin(uTime * (0.4 + aStar.w * 0.9) + aStar.w * 40.0);
  float big = step(0.93, aStar.w);
  vBright = twinkle * (0.12 + pow(aStar.w, 5.0) * 1.3) * uAmount * mix(1.0, 2.2, big);
  gl_PointSize = uSize * mix(1.0, 2.0, big);
}`;

export const STAR_FRAGMENT = `#version 300 es
precision mediump float;
in float vBright;
out vec4 outColor;
void main() { outColor = vec4(vec3(0.82, 0.88, 1.0) * vBright, 1.0); }`;

export const ADD_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vClip;
uniform sampler2D uImage;
uniform float uWeight;
out vec4 outColor;
void main() {
  vec3 color = texture(uImage, vClip * 0.5 + 0.5).rgb;
  outColor = vec4(min(color, vec3(80.0)) * uWeight, 1.0);
}`;
export const ADD_VERTEX = FULLSCREEN;

export const DOWN_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vClip;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform float uThreshold;
out vec4 outColor;
vec3 tap(vec2 uv) { return texture(uImage, uv).rgb; }
void main() {
  vec2 uv = vClip * 0.5 + 0.5;
  vec2 d = uTexel;
  vec3 a = tap(uv + d * vec2(-2, 2)), b = tap(uv + d * vec2(0, 2)), c = tap(uv + d * vec2(2, 2));
  vec3 e = tap(uv + d * vec2(-2, 0)), f = tap(uv), g = tap(uv + d * vec2(2, 0));
  vec3 h = tap(uv + d * vec2(-2, -2)), i = tap(uv + d * vec2(0, -2)), j = tap(uv + d * vec2(2, -2));
  vec3 k = tap(uv + d * vec2(-1, 1)), l = tap(uv + d * vec2(1, 1)), m = tap(uv + d * vec2(-1, -1)), n = tap(uv + d * vec2(1, -1));
  vec3 color = f * 0.125 + (a + c + h + j) * 0.03125 + (b + e + g + i) * 0.0625 + (k + l + m + n) * 0.125;
  if (uThreshold > 0.0) {
    float bright = max(color.r, max(color.g, color.b));
    color *= smoothstep(uThreshold * 0.6, uThreshold * 1.6, bright);
  }
  outColor = vec4(color, 1.0);
}`;
export const DOWN_VERTEX = FULLSCREEN;

export const UP_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vClip;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform float uSpread;
out vec4 outColor;
void main() {
  vec2 uv = vClip * 0.5 + 0.5;
  vec2 d = uTexel * uSpread;
  vec3 color = texture(uImage, uv).rgb * 4.0;
  color += (texture(uImage, uv + vec2(d.x, 0)).rgb + texture(uImage, uv - vec2(d.x, 0)).rgb + texture(uImage, uv + vec2(0, d.y)).rgb + texture(uImage, uv - vec2(0, d.y)).rgb) * 2.0;
  color += texture(uImage, uv + d).rgb + texture(uImage, uv - d).rgb + texture(uImage, uv + vec2(d.x, -d.y)).rgb + texture(uImage, uv + vec2(-d.x, d.y)).rgb;
  outColor = vec4(color / 16.0, 1.0);
}`;
export const UP_VERTEX = FULLSCREEN;

export const FINAL_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vClip;
uniform sampler2D uImage, uBloom;
uniform float uExposure, uBloomAmount, uVignette, uGrain, uTime, uAberration, uFade;
uniform vec3 uFlash, uLift, uGain;
out vec4 outColor;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/** 高光慢慢滚到白，暗部不压死。 */
vec3 tone(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  // 无头渲染读回来是倒的，这里翻过来，ffmpeg 就不用管了。
  vec2 clip = vec2(vClip.x, -vClip.y);
  vec2 uv = clip * 0.5 + 0.5;
  vec2 off = clip * dot(clip, clip) * uAberration;
  vec3 color = vec3(texture(uImage, uv - off).r, texture(uImage, uv).g, texture(uImage, uv + off).b);
  color += texture(uBloom, uv).rgb * uBloomAmount;
  color += uFlash;
  color *= uExposure;
  float edge = dot(clip * vec2(0.92, 1.0), clip * vec2(0.92, 1.0));
  color *= 1.0 - uVignette * smoothstep(0.25, 1.9, edge);
  color = tone(color);
  color = pow(color, vec3(1.0 / 2.2));
  color = color * uGain + uLift * (1.0 - color);
  vec2 seed = gl_FragCoord.xy + fract(uTime * 7.31) * 311.7;
  float n = hash(seed) + hash(seed + 17.0) - 1.0;
  color += n * uGrain;
  outColor = vec4(color * uFade, 1.0);
}`;
export const FINAL_VERTEX = FULLSCREEN;
