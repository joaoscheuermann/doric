// @ts-nocheck
// Vendored: Figma shader effect "Bitmap orgânico", file ITniMiH6BnZHhuX6NkJhqP,
// shader 071018be-b00a-4c0a-83da-1729a60fc95b, version
// 2d24f46323ce8a35993d022830f285c2421814f6 (main.ts), read 2026-11-09 with
// the Figma MCP get_shader. © jao.scheuermann, MIT (UR19). Edits (S19): this
// header, the @ts-nocheck line and the figma:shaders import replaced by a
// no-op defineProperties. See app/desktop/doric/PROVENANCE.md.
/**
 * Bitmap orgânico — Figma Design, Shader Effect (kind: "effect").
 * Fonte completa para main.ts no runtime nativo figma:shaders.
 * Controles: Tamanho 12 px; Densidade 0; Contraste 110%; Conexao 60%.
 * Mantém a grade a 45 graus, pontos nas luzes, variação fixa nos meios-tons,
 * conexões gaussianas; cores editáveis com padrão preto sobre branco opaco.
 * A entrada do Figma é premultiplicada; transparência é composta sobre branco.
 * O resultado continua sendo um efeito raster ajustável nas camadas.
 */
function defineProperties(_component: unknown, _properties: unknown): void {}

export default function Effect() {}

export function setup(device, frame) {
  var common = `diagnostic(off,derivative_uniformity);

struct Params {
  dimensions: vec2f,
  spacing: f32,
  side: u32,
  density: f32,
  contrast: f32,
  connection: f32,
  render_scale: f32,
  ink_color: vec4f,
  background_color: vec4f,
}
@group(0) @binding(0) var<uniform> p: Params;
const SQRT_HALF: f32 = 0.70710678118;
fn to_grid(v: vec2f) -> vec2f {
  return vec2f(v.x + v.y, v.y - v.x) * SQRT_HALF;
}
fn from_grid(v: vec2f) -> vec2f {
  return vec2f(v.x - v.y, v.x + v.y) * SQRT_HALF;
}
fn sharpness() -> f32 {
  let sigma = mix(0.20, 0.30, p.connection);
  return 1.0 / (2.0 * sigma * sigma);
}
`;
  var computeCode = common + `
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;
@group(0) @binding(3) var<storage, read_write> amplitudes: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.side || id.y >= p.side) { return; }
  let cell = vec2f(id.xy) + 0.5 - f32(p.side) * 0.5;
  let center = from_grid(cell * p.spacing) + p.dimensions * 0.5;
  var luminance = 0.0;
  // Média 4×4 na célula: evita decidir todo o ponto por um único texel.
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let offset = (vec2f(f32(x), f32(y)) + 0.5) / 4.0 - 0.5;
      let uv = (center + from_grid(offset * p.spacing)) / p.dimensions;
      let rgba = textureSampleLevel(source, source_sampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
      let rgb = rgba.rgb + vec3f(1.0 - rgba.a);
      luminance += dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    }
  }
  let tone = clamp((1.0 - luminance / 16.0 - 0.5) * p.contrast
                   + 0.5 + p.density, 0.0, 1.0);
  // Variação fixa por célula quebra a malha rígida nos meios-tons.
  // Não muda entre renders, nem acrescenta ruído nas luzes/sombras extremas.
  var hash = id.x * 1664525u + id.y * 1013904223u + 374761393u;
  hash = (hash ^ (hash >> 16u)) * 2246822519u;
  hash = (hash ^ (hash >> 13u)) * 3266489917u;
  hash = hash ^ (hash >> 16u);
  let noise = f32(hash & 0x00ffffffu) / 16777215.0 - 0.5;
  let dark = clamp(tone + noise * 0.14 * (4.0 * tone * (1.0 - tone)), 0.0, 1.0);
  let k = sharpness();
  // Pequenos pontos nas luzes; sombras crescem e se unem organicamente.
  // A compensação final permite preencher completamente os tons pretos.
  let fill_radius2 = 0.5 - log(4.0) / k + 0.005;
  let radius2 = 0.004 + dark / 3.14159265
    + smoothstep(0.75, 1.0, dark) * max(0.0, fill_radius2 - 0.32231);
  amplitudes[id.y * p.side + id.x] = exp(k * radius2);
}
`;
  var renderCode = common + `
@group(0) @binding(1) var<storage, read> amplitudes: array<f32>;

fn field_at(position: vec2f) -> f32 {
  let grid = to_grid(position - p.dimensions * 0.5) / p.spacing
             + f32(p.side) * 0.5 - 0.5;
  let nearest = vec2i(floor(grid + 0.5));
  let k = sharpness();
  var field = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let cell = clamp(nearest + vec2i(x, y), vec2i(0), vec2i(i32(p.side) - 1));
      let delta = grid - vec2f(cell);
      field += amplitudes[u32(cell.y) * p.side + u32(cell.x)]
                 * exp(-k * dot(delta, delta));
    }
  }
  return field;
}

@vertex
fn vs_main(@location(0) position: vec2f, @location(1) uv: vec2f) -> @builtin(position) vec4f {
  return vec4f(position, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let field = field_at(position.xy / p.render_scale);
  let aa = max(fwidth(field) * 0.5, 0.001);
  let ink = smoothstep(1.0 - aa, 1.0 + aa, field);
  let inkColor = vec4f(p.ink_color.rgb * p.ink_color.a, p.ink_color.a);
  let backgroundColor = vec4f(p.background_color.rgb * p.background_color.a, p.background_color.a);
  return mix(backgroundColor, inkColor, ink);
}
`;

  frame.state.computeModule = device.createShaderModule({
    label: "Bitmap organico: luminosidade por celula", code: computeCode,
  });
  frame.state.renderModule = device.createShaderModule({
    label: "Bitmap organico: pontos e conexoes", code: renderCode,
  });
  frame.state.uniforms = device.createBuffer({
    label: "Bitmap organico: parametros", size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  frame.state.imageSampler = device.createSampler({
    magFilter: "linear", minFilter: "linear",
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
  });
  frame.state.quad = device.createBuffer({
    size: 96, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true,
  });
  new Float32Array(frame.state.quad.getMappedRange()).set([
    -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0,
    -1, 1, 0, 0, 1, -1, 1, 1, 1, 1, 1, 0,
  ]);
  frame.state.quad.unmap();
}

export function render(device, frame) {
  var state = frame.state;
  if (!state.uniforms) setup(device, frame);

  // O input pode estar ausente durante a preparação inicial do efeito.
  if (frame.input == null) {
    var clearEncoder = device.createCommandEncoder();
    var clearPass = clearEncoder.beginRenderPass({ colorAttachments: [{
      view: frame.output.createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: "clear", storeOp: "store",
    }] });
    clearPass.end();
    device.queue.submit([clearEncoder.finish()]);
    return;
  }

  var params = frame.params || {};
  var bounded = (value, fallback, lower, upper) =>
    Math.min(upper, Math.max(lower, Number.isFinite(value) ? value : fallback));
  var renderScale = Math.max(frame.renderScale || 1, 0.0001);
  var width = (frame.output.physicalWidth ?? frame.output.width) / renderScale;
  var height = (frame.output.physicalHeight ?? frame.output.height) / renderScale;
  var spacing = bounded(params.Tamanho, 12, 4, 100);
  var density = bounded(params.Densidade, 0, -50, 50) / 100;
  var contrast = bounded(params.Contraste, 110, 25, 250) / 100;
  var connection = bounded(params.Conexao, 60, 0, 100) / 100;
  var side = Math.ceil((width + height) * Math.SQRT1_2 / spacing) + 4;
  var bytes = side * side * 4;
  if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize) {
    throw new Error("Aumente Tamanho ou reduza as dimensões da camada para aplicar o bitmap orgânico.");
  }

  if (!state.computePipeline) {
    state.computePipeline = device.createComputePipeline({
      label: "Bitmap organico: compute", layout: "auto",
      compute: { module: state.computeModule, entryPoint: "main" },
    });
  }
  if (!state.renderPipeline || state.outputFormat !== frame.output.format) {
    state.renderPipeline = device.createRenderPipeline({
      label: "Bitmap organico: render", layout: "auto",
      vertex: {
        module: state.renderModule, entryPoint: "vs_main",
        buffers: [{ arrayStride: 16, attributes: [
          { shaderLocation: 0, format: "float32x2", offset: 0 },
          { shaderLocation: 1, format: "float32x2", offset: 8 },
        ] }],
      },
      fragment: {
        module: state.renderModule, entryPoint: "fs_main",
        targets: [{ format: frame.output.format }],
      },
      primitive: { topology: "triangle-list" },
    });
    state.outputFormat = frame.output.format;
  }
  if (!state.cells || state.gridSide !== side) {
    if (state.cells) state.cells.destroy();
    state.cells = device.createBuffer({
      label: "Bitmap organico: amplitudes", size: bytes,
      usage: GPUBufferUsage.STORAGE,
    });
    state.gridSide = side;
  }

  // Params: dimensions=0..7, spacing=8, side(uint32)=12,
  // density=16, contrast=20, connection=24, renderScale=28,
  // ink RGBA=32..47, background RGBA=48..63 (64 bytes).
  var inkColor = params.CorDosPontos || { r: 0, g: 0, b: 0, a: 1 };
  var backgroundColor = params.CorDoFundo || { r: 1, g: 1, b: 1, a: 1 };
  var data = new ArrayBuffer(64);
  new Float32Array(data).set([width, height, spacing, 0, density, contrast, connection, renderScale]);
  new Float32Array(data).set([
    bounded(inkColor.r, 0, 0, 1), bounded(inkColor.g, 0, 0, 1),
    bounded(inkColor.b, 0, 0, 1), bounded(inkColor.a, 1, 0, 1),
    bounded(backgroundColor.r, 1, 0, 1), bounded(backgroundColor.g, 1, 0, 1),
    bounded(backgroundColor.b, 1, 0, 1), bounded(backgroundColor.a, 1, 0, 1),
  ], 8);
  new Uint32Array(data)[3] = side;
  device.queue.writeBuffer(state.uniforms, 0, data);

  // Reconstruir o bind group: o Figma pode trocar a textura de entrada.
  var computeGroup = device.createBindGroup({
    layout: state.computePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: state.uniforms } },
      { binding: 1, resource: frame.input.createView() },
      { binding: 2, resource: state.imageSampler },
      { binding: 3, resource: { buffer: state.cells } },
    ],
  });
  var renderGroup = device.createBindGroup({
    layout: state.renderPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: state.uniforms } },
      { binding: 1, resource: { buffer: state.cells } },
    ],
  });
  var encoder = device.createCommandEncoder();
  var compute = encoder.beginComputePass();
  compute.setPipeline(state.computePipeline);
  compute.setBindGroup(0, computeGroup);
  compute.dispatchWorkgroups(Math.ceil(side / 8), Math.ceil(side / 8));
  compute.end();
  var pass = encoder.beginRenderPass({ colorAttachments: [{
    view: frame.output.createView(), clearValue: { r: 1, g: 1, b: 1, a: 1 },
    loadOp: "clear", storeOp: "store",
  }] });
  pass.setPipeline(state.renderPipeline);
  pass.setBindGroup(0, renderGroup);
  pass.setVertexBuffer(0, state.quad);
  pass.draw(6);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

defineProperties(Effect, {
  Tamanho: {
    type: "number", defaultValue: 12,
    min: 4, max: 100, step: 1, control: "slider", unit: "px",
  },
  Densidade: {
    type: "number", defaultValue: 0,
    min: -50, max: 50, step: 1, control: "slider",
  },
  Contraste: {
    type: "number", defaultValue: 110,
    min: 25, max: 250, step: 5, control: "slider", unit: "%",
  },
  Conexao: {
    type: "number", defaultValue: 60,
    min: 0, max: 100, step: 1, control: "slider", unit: "%",
  },
  CorDosPontos: {
    type: "color", label: "Cor dos pontos",
    defaultValue: { r: 0, g: 0, b: 0, a: 1 },
  },
  CorDoFundo: {
    type: "color", label: "Cor do fundo",
    defaultValue: { r: 1, g: 1, b: 1, a: 1 },
  },
});
