// Runs the vendored shader (S19) on one photograph into the art pane's canvas.

import { render } from '../vendor/bitmap-organico';

/** The canvas's CSS size: layer `302:22443`, as `splash.css` sets it. */
export const ART_CANVAS_SIZE = { width: 372.067, height: 538.276 } as const;

/** The shader's parameters on layer `302:22443` (S19). */
export const SPLASH_ART_PARAMS = {
  Tamanho: 5,
  Densidade: 5,
  Contraste: 75,
  Conexao: 50,
  CorDosPontos: {
    r: 0.1411764770746231,
    g: 0.12941177189350128,
    b: 0.11372549086809158,
    a: 1,
  },
  CorDoFundo: {
    r: 0.929411768913269,
    g: 0.8941176533699036,
    b: 0.8274509906768799,
    a: 1,
  },
} as const;

/**
 * Configures the canvas, uploads the photograph and draws it once; answers
 * the redraw, which sizes the backing store to the current device-pixel ratio
 * and draws again with the same shader state. Throws what `render` throws.
 */
export const drawArt = (input: {
  readonly canvas: HTMLCanvasElement;
  readonly device: GPUDevice;
  readonly image: ImageBitmap;
}): (() => void) => {
  const { canvas, device, image } = input;
  const context = canvas.getContext('webgpu');

  if (context === null) {
    throw new Error('The canvas has no webgpu context.');
  }

  context.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: 'opaque',
  });

  const texture = device.createTexture({
    format: 'rgba8unorm',
    size: [image.width, image.height],
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.copyExternalImageToTexture({ source: image }, { texture }, [
    image.width,
    image.height,
  ]);

  const state = {};
  const draw = (): void => {
    const ratio = window.devicePixelRatio;

    canvas.width = Math.round(ART_CANVAS_SIZE.width * ratio);
    canvas.height = Math.round(ART_CANVAS_SIZE.height * ratio);
    render(device, {
      state,
      input: texture,
      output: context.getCurrentTexture(),
      params: SPLASH_ART_PARAMS,
      renderScale: ratio,
    });
  };

  draw();

  return draw;
};
