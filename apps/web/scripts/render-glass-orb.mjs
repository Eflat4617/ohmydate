#!/usr/bin/env node
// HOLO-01: renders OhMyDate's own glass object (src/components/ui/glassOrbShader.ts)
// to the still image that stands in for it when WebGL is missing:
//
//   node scripts/render-glass-orb.mjs                 # writes src/assets/glass-orb.webp
//   node scripts/render-glass-orb.mjs --out /tmp/x.png --time 12.5 --light 1 --size 640
//
// The picture is drawn by this project's shader in a headless browser; nothing
// else goes into it. Commit the result when the shader changes.
/* global document -- used only inside page.evaluate() browser callbacks */
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const source = await readFile(join(webRoot, 'src/components/ui/glassOrbShader.ts'), 'utf8');

function between(kind) {
  const match = new RegExp(`/\\* glsl:${kind}:begin \\*/ \`([\\s\\S]*?)\` /\\* glsl:${kind}:end \\*/`).exec(source);
  if (match === null) throw new Error(`glassOrbShader.ts has no ${kind} shader markers`);
  return match[1];
}

const stillTime = Number(/GLASS_STILL_TIME = ([\d.]+)/.exec(source)?.[1] ?? '0');
const out = resolve(arg('out', join(webRoot, 'src/assets/glass-orb.webp')));
const size = Number(arg('size', '560'));
const time = Number(arg('time', String(stillTime)));
const light = Number(arg('light', '0'));
const type = extname(out) === '.png' ? 'image/png' : 'image/webp';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>glass</title><canvas id="c"></canvas>');
  const dataUrl = await page.evaluate(
    ({ vertex, fragment, size: side, time: at, light: scheme, type: mime }) => {
      const canvas = document.getElementById('c');
      canvas.width = side;
      canvas.height = side;
      const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
      if (gl === null) throw new Error('WebGL is not available in this browser');
      const compile = (kind, text) => {
        const shader = gl.createShader(kind);
        gl.shaderSource(shader, text);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      };
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, side, side);
      gl.uniform2f(gl.getUniformLocation(program, 'u_res'), side, side);
      gl.uniform1f(gl.getUniformLocation(program, 'u_time'), at);
      gl.uniform1f(gl.getUniformLocation(program, 'u_light'), scheme);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.finish();
      return canvas.toDataURL(mime, 0.92);
    },
    { vertex: between('vertex'), fragment: between('fragment'), size, time, light, type },
  );
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await writeFile(out, bytes);
  console.log(`${out}  ${size}x${size}  t=${time}  light=${light}  ${bytes.length} bytes`);
} finally {
  await browser.close();
}
