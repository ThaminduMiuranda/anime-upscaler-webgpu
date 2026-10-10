// WebGPU device management + per-video renderer.
(() => {
  const NS = (globalThis.VideoUpscaler ||= {});
  if (NS.Renderer) return;

  const PASS_NAMES = ['prep', 'upscale', 'edges', 'warp', 'present'];
  const PASS_FORMATS = { prep: 'rgba16float', upscale: 'rgba16float', edges: 'r16float', warp: 'rgba16float' };
  const UNIFORM_FLOATS = 12; // must match `struct Params` in shaders.js (48 bytes)

  let gpuPromise = null;

  function describeAdapter(info) {
    if (!info) return 'Unknown GPU';
    return info.description || [info.vendor, info.architecture].filter(Boolean).join(' ') || 'Unknown GPU';
  }

  async function buildPipeline(device, name, code, format) {
    const label = `video-upscaler:${name}`;
    const module = device.createShaderModule({ label, code: NS.SHADERS.common + code });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length) {
      throw new Error(`Shader "${name}" failed to compile: ` +
        errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));
    }
    return device.createRenderPipelineAsync({
      label,
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  async function initGpu() {
    if (!navigator.gpu) throw new Error('WebGPU is not available (navigator.gpu is missing)');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found');
    const device = await adapter.requestDevice({ label: 'video-upscaler' });
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

    const gpu = {
      device,
      canvasFormat,
      adapterName: describeAdapter(adapter.info),
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
      lost: false,
      pipelines: null,
      sampler: null,
    };

    device.addEventListener('uncapturederror', (ev) => {
      console.warn('[Video Upscaler] GPU error:', ev.error?.message);
    });

    (async () => {
      const info = await device.lost;
      gpu.lost = true;
      if (gpuPromise) gpuPromise = null;
      console.warn('[Video Upscaler] GPU device lost:', info?.message);
      NS.onDeviceLost?.(info);
    })();

    const pipelines = { external: {}, copy: {} };
    for (const n of PASS_NAMES) {
      const format = PASS_FORMATS[n] || canvasFormat;
      if (n === 'prep' || n === 'present') {
        pipelines.external[n] = await buildPipeline(device, n + '_ext', NS.SHADERS[n]('external'), format);
        pipelines.copy[n] = await buildPipeline(device, n + '_cpy', NS.SHADERS[n]('copy'), format);
      } else {
        const p = await buildPipeline(device, n, NS.SHADERS[n], format);
        pipelines.external[n] = p;
        pipelines.copy[n] = p;
      }
    }
    gpu.pipelines = pipelines;
    gpu.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    return gpu;
  }

  /** Lazily creates (once per frame/document) the shared GPU device + pipelines. */
  NS.getGpu = async () => {
    if (!gpuPromise) gpuPromise = initGpu();
    try {
      return await gpuPromise;
    } catch (err) {
      gpuPromise = null;
      throw err;
    }
  };

  class Renderer {
    constructor(gpu, canvas) {
      this.gpu = gpu;
      this.canvas = canvas;
      this.ctx = canvas.getContext('webgpu');
      if (!this.ctx) throw new Error('Could not create a WebGPU canvas context');
      this.ctx.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'opaque' });
      this.ubuf = gpu.device.createBuffer({
        label: 'video-upscaler:params',
        size: UNIFORM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.uniforms = new Float32Array(UNIFORM_FLOATS);
      this.textures = null;
      this.views = null;
      this.cachedGroups = null;
      this.sizeKey = '';
      this.useCopyFallback = false;
    }

    bindGroup(pipeline, resources) {
      return this.gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: resources.map((resource, binding) => ({ binding, resource })),
      });
    }

    ensureTargets(vw, vh, ow, oh) {
      const key = `${vw}x${vh}>${ow}x${oh}-copy:${this.useCopyFallback}`;
      if (key === this.sizeKey) return;
      this.destroyTargets();
      const { device, pipelines: P, sampler } = this.gpu;
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      const mk = (w, h, format, label) =>
        device.createTexture({ label: `video-upscaler:${label}`, size: [w, h], format, usage });

      const t = {
        src: mk(vw, vh, 'rgba16float', 'src'),
        up: mk(ow, oh, 'rgba16float', 'upscaled'),
        edge: mk(ow, oh, 'r16float', 'edges'),
        warp: mk(ow, oh, 'rgba16float', 'warped'),
      };

      if (this.useCopyFallback) {
        t.videoCopy = device.createTexture({
          label: 'video-upscaler:video-copy',
          size: [vw, vh],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }

      const v = Object.fromEntries(Object.entries(t).map(([k, tex]) => [k, tex.createView()]));
      const u = { buffer: this.ubuf };
      
      const pipelines = this.useCopyFallback ? P.copy : P.external;
      
      this.cachedGroups = {
        upscale: this.bindGroup(pipelines.upscale, [u, v.src, sampler]),
        edges: this.bindGroup(pipelines.edges, [u, v.up, sampler]),
        warp: this.bindGroup(pipelines.warp, [u, v.up, v.edge, sampler]),
      };
      this.textures = t;
      this.views = v;
      this.sizeKey = key;
    }

    static pass(encoder, pipeline, group, view) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }

    /**
     * Renders the video's current frame, upscaled to ow x oh, into the canvas.
     * Throws a SecurityError if the video is not origin-clean (cross-origin without CORS).
     */
    async render(video, ow, oh, s) {
      const { device, pipelines: P, sampler } = this.gpu;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (this.canvas.width !== ow) this.canvas.width = ow;
      if (this.canvas.height !== oh) this.canvas.height = oh;
      this.ensureTargets(vw, vh, ow, oh);

      const refine = s.warp > 0.001 || s.lineDarken > 0.001;
      this.uniforms.set([vw, vh, ow, oh, s.denoise, s.edgeAA, s.warp, s.lineDarken, s.sharpen,
        s.compare ? 0.5 : -1, 0, 0]);
      device.queue.writeBuffer(this.ubuf, 0, this.uniforms);

      let pipelines = this.useCopyFallback ? P.copy : P.external;
      let videoSourceResource;
      
      try {
        if (this.useCopyFallback) {
          const bmp = await createImageBitmap(video);
          device.queue.copyExternalImageToTexture(
            { source: bmp },
            { texture: this.textures.videoCopy },
            [vw, vh]
          );
          bmp.close();
          videoSourceResource = this.views.videoCopy;
        } else {
          // External textures expire after the current task, so their bind groups are per-frame.
          videoSourceResource = device.importExternalTexture({ source: video });
        }
      } catch (err) {
        if (!this.useCopyFallback && (err.name === 'OperationError' || err.name === 'DOMException') && !this.gpu.adapterName.toLowerCase().includes('swiftshader')) {
          console.warn('[Video Upscaler] importExternalTexture failed, falling back to ImageBitmap proxy:', err);
          this.useCopyFallback = true;
          this.sizeKey = ''; // Force target recreation
          this.ensureTargets(vw, vh, ow, oh);
          pipelines = P.copy;
          
          const bmp = await createImageBitmap(video);
          device.queue.copyExternalImageToTexture(
            { source: bmp },
            { texture: this.textures.videoCopy },
            [vw, vh]
          );
          bmp.close();
          videoSourceResource = this.views.videoCopy;
        } else {
          throw err;
        }
      }

      const u = { buffer: this.ubuf };
      const v = this.views;
      const enc = device.createCommandEncoder({ label: 'video-upscaler:frame' });

      Renderer.pass(enc, pipelines.prep, this.bindGroup(pipelines.prep, [u, videoSourceResource]), v.src);
      Renderer.pass(enc, pipelines.upscale, this.cachedGroups.upscale, v.up);
      let finalView = v.up;
      if (refine) {
        Renderer.pass(enc, pipelines.edges, this.cachedGroups.edges, v.edge);
        Renderer.pass(enc, pipelines.warp, this.cachedGroups.warp, v.warp);
        finalView = v.warp;
      }
      Renderer.pass(enc, pipelines.present, this.bindGroup(pipelines.present, [u, finalView, videoSourceResource]),
        this.ctx.getCurrentTexture().createView());
      device.queue.submit([enc.finish()]);
    }

    destroyTargets() {
      if (this.textures) for (const t of Object.values(this.textures)) t.destroy();
      this.textures = null;
      this.views = null;
      this.cachedGroups = null;
      this.sizeKey = '';
    }

    destroy() {
      this.destroyTargets();
      this.ubuf?.destroy();
      this.ubuf = null;
      try {
        this.ctx?.unconfigure();
      } catch {
        // context may already be gone
      }
    }
  }

  NS.Renderer = Renderer;
})();
