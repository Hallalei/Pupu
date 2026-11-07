/** WebGL2 的小工具。program 和 upload 的写法和登录页 pupu-art.ts 一样。 */
import { VERTEX_FLOATS, type Mesh } from "../../../apps/cloud/src/client/pupu-voxels.ts";

export type Program = { use: () => void; at: (name: string) => WebGLUniformLocation | null };

export function program(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const made = gl.createProgram()!;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment]
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`${gl.getShaderInfoLog(shader)}\n${source}`);
    gl.attachShader(made, shader);
  }
  gl.linkProgram(made);
  if (!gl.getProgramParameter(made, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(made) ?? "program");
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  return {
    use: () => gl.useProgram(made),
    at(name) {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(made, name));
      return uniforms.get(name)!;
    }
  };
}

/** 一块模型加它的实例缓冲。一个实例 24 个数：矩阵 16、色调加自发光 4、雾量材质等 4。 */
export const INSTANCE_FLOATS = 24;

export type Part = {
  vao: WebGLVertexArrayObject;
  count: number;
  instances: WebGLBuffer;
  data: Float32Array;
  used: number;
  caster: boolean;
};

export function upload(gl: WebGL2RenderingContext, mesh: Mesh, caster = true): Part {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  const stride = VERTEX_FLOATS * 4;
  [3, 3, 3, 2].reduce((offset, size, index) => {
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset * 4);
    return offset + size;
  }, 0);
  const instances = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  const bytes = INSTANCE_FLOATS * 4;
  for (let column = 0; column < 6; column++) {
    const at = 4 + column;
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 4, gl.FLOAT, false, bytes, column * 16);
    gl.vertexAttribDivisor(at, 1);
  }
  gl.bindVertexArray(null);
  return { vao, count: mesh.count, instances, data: new Float32Array(INSTANCE_FLOATS * 64), used: 0, caster };
}

export function reserve(part: Part, extra: number) {
  const need = (part.used + extra) * INSTANCE_FLOATS;
  if (need <= part.data.length) return;
  const grown = new Float32Array(Math.max(need, part.data.length * 2));
  grown.set(part.data.subarray(0, part.used * INSTANCE_FLOATS));
  part.data = grown;
}

export type Target = { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number };

export function colorTarget(gl: WebGL2RenderingContext, width: number, height: number, format: number, depth = false): Target {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (depth) {
    const buffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, buffer);
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer ${status}`);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture, width, height };
}

export type ShadowMap = { framebuffer: WebGLFramebuffer; texture: WebGLTexture; size: number };

export function shadowTarget(gl: WebGL2RenderingContext, size: number): ShadowMap {
  const texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture, size };
}
