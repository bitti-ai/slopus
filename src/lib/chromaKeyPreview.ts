import { applyChromaKey, keyColor, KEY_FEATHER, RGB_DISTANCE_SCALE } from "./chromaKey";
import type { ClipChromaKey } from "./project";

type Picture = HTMLVideoElement | HTMLImageElement;
export interface ChromaKeyRenderer {
  draw(source: Picture, key: ClipChromaKey): void;
  dispose(): void;
}

/** Upload media directly as a texture; no pixel readback during GPU playback. */
export function createChromaKeyRenderer(canvas: HTMLCanvasElement): ChromaKeyRenderer {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This computer could not create a Chroma Key preview.");
    return {
      draw(source, key) {
        const [width, height] = dimensions(source);
        if (!width || !height) return;
        // Bound CPU work to a monitor-sized picture on machines without WebGL.
        const scale = Math.min(1, 1280 / width);
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        applyChromaKey(pixels.data, key);
        context.putImageData(pixels, 0, 0);
      },
      dispose() {},
    };
  }
  const shaders: WebGLShader[] = [];
  const program = gl.createProgram();
  const vertices = gl.createBuffer();
  const texture = gl.createTexture();
  const dispose = () => {
    shaders.forEach((shader) => gl.deleteShader(shader));
    gl.deleteProgram(program);
    gl.deleteBuffer(vertices);
    gl.deleteTexture(texture);
  };
  try {
    if (!program || !vertices || !texture) throw new Error("Could not allocate the Chroma Key preview.");
    const compile = (type: number, code: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Could not allocate the Chroma Key shader.");
      shaders.push(shader);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Chroma Key shader failed.");
      gl.attachShader(program, shader);
    };
    compile(gl.VERTEX_SHADER, `
      attribute vec2 position;
      varying vec2 uv;
      void main() { uv = (position + 1.0) * 0.5; gl_Position = vec4(position, 0.0, 1.0); }
    `);
    compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 uv;
      uniform sampler2D source;
      uniform vec4 key;
      void main() {
        vec4 sampled = texture2D(source, uv);
        float difference = distance(sampled.rgb, key.rgb) / ${RGB_DISTANCE_SCALE};
        float alpha = smoothstep(key.a, key.a + ${KEY_FEATHER}, difference);
        gl_FragColor = vec4(sampled.rgb, sampled.a * alpha);
      }
    `);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Chroma Key shader failed to link.");
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, "source"), 0);
    const keyUniform = gl.getUniformLocation(program, "key");
    return {
      draw(source, key) {
        const [width, height] = dimensions(source);
        if (!width || !height) return;
        if (gl.isContextLost()) throw new Error("The GPU stopped responding during Chroma Key preview.");
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        gl.viewport(0, 0, width, height);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.uniform4f(keyUniform, ...keyColor(key.color), key.tolerance / 100);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

function dimensions(source: Picture): [number, number] {
  return source instanceof HTMLVideoElement
    ? source.readyState >= 2 ? [source.videoWidth, source.videoHeight] : [0, 0]
    : source.complete ? [source.naturalWidth, source.naturalHeight] : [0, 0];
}
