# SPEEDBALL GI WebGPU Showcase

An interactive Three.js showcase for real-time, BVH-traced dynamic diffuse global illumination (DDGI) with [`speedball-gi`](https://github.com/cl0nazepamm/speedball).

This Vite application extends the upstream Sponza demo with two focused test scenes: a compact procedural court for reading indirect color and a physics-driven ball pool for observing GI around moving instanced geometry.

[Open the upstream Sponza demo](https://cl0nazepamm.github.io/speedball/) · [View `speedball-gi` on npm](https://www.npmjs.com/package/speedball-gi)

## Highlights

- Three complementary WebGPU scenes: architectural, procedural, and dynamic.
- World-space DDGI with automatic probe-volume fitting and optional probe visualization.
- Rough and glossy local probe reflections in the Sponza and Afterimage Court scenes.
- Live controls for probe layout, ray count, temporal response, leak reduction, sky contribution, and display settings.
- A shared post-processing stack: GTAO, temporal reprojection anti-aliasing (TRAA), and bloom.
- A responsive HUD and GUI for desktop and small viewports.

## Demo scenes

| Route | Scene | What it demonstrates |
| --- | --- | --- |
| `/` | **Sponza** | The upstream Sponza setup adapted for Vite, with a procedural sky, directional sun, auto-fitted DDGI, local reflections, probe debugging, and an animated metallic receiver. |
| `/simple.html` | **Afterimage Court** | A lightweight colonnade with red and green walls, a skylit central path, and simple materials designed to make indirect color transfer easy to compare. |
| `/ballpool.html` | **Ball Pool** | A physics simulation with instanced spheres, a pointer-controlled light, and continuously changing geometry that exercises dynamic GI updates. The pool width and ball count adapt to the viewport. |

Navigation links in the upper-left HUD connect all three scenes.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm `>=11.10.0`
- A browser and device with WebGPU support
- A secure browser context: `localhost` during development or HTTPS when hosted

There is no WebGL fallback. The demo also requires the WebGPU storage features used by `speedball-gi`.

## Getting started

```bash
git clone https://github.com/norio/speedball-gi.git
cd speedball-gi
npm ci
npm run dev
```

Open the URL printed by Vite, normally [http://localhost:5173](http://localhost:5173), for Sponza. Then use the in-app links or open the other routes on the same origin:

- `/simple.html`
- `/ballpool.html`

## Controls

### Sponza

- Drag to orbit the camera.
- Scroll to zoom.
- Use **Sky / Sun** to change the sun direction and atmosphere.
- Use **GI** to tune the probe field or show probe locations.
- Use **Post** to configure GTAO, TRAA, and bloom.
- Use **Display** to change tone mapping, exposure, texture visibility, device pixel ratio, or the frame-rate cap.
- Stop moving the camera or GUI controls to let the idle-gated probe solve converge.

### Afterimage Court

- Drag to orbit and scroll to zoom.
- Press <kbd>G</kbd> to compare GI with direct lighting only.
- Adjust the sun intensity and exposure in **Court**.
- Use the shared **GI** and **Post** folders for lighting and post-processing controls.

### Ball Pool

- Move the pointer over the scene to move the light and push nearby balls.
- Hold the mouse button to return balls to the top of the pool.
- On touch devices, use two simultaneous pointers to return balls.
- Press <kbd>G</kbd> to compare GI with direct lighting only.
- Use **drop 20 balls** in the **Ball Pool** folder for an immediate reset burst.

## How the integration works

`installSpeedballGI()` is called during setup, before the first render or `renderer.setAnimationLoop()`. This ordering is required because SPEEDBALL GI installs a GI-aware Three.js lights node before lit materials compile.

Each scene then:

1. Creates or loads its geometry and lighting.
2. Requests a probe-field rebuild after the scene is ready.
3. Calls `gi.update({ playing: false })` once per frame.
4. Renders through the shared post-processing pipeline.

The `playing: false` option does not turn GI off or pause the Ball Pool physics. It marks these scenes as not playing a timeline, allowing SPEEDBALL GI's idle gate to defer heavy builds and rebuilds until camera or GUI interaction settles.

Sky meshes, probe helpers, and diagnostic reflection objects are excluded from GI tracing where appropriate so they do not enlarge the automatic bounds or contaminate their own lighting.

## Rendering pipeline

All scenes use the same pre-tonemapping pipeline:

1. A WebGPU scene pass writes color, depth, velocity, and view-space normals.
2. GTAO modulates the scene color.
3. TRAA resolves camera jitter and temporal history.
4. Bloom is composited over the resolved image.
5. The renderer applies the selected tone mapping and exposure.

Canvas MSAA is disabled because TRAA supplies the anti-aliasing stage.

## Behavior and limitations

- Probe lighting converges over time. The initial load and changes to lights, geometry, or grid structure may take several frames to settle.
- Local probe reflections are an approximate, off-screen-stable lighting layer rather than pixel-accurate mirror reflections or path tracing.
- The Sponza loader adjusts strongly metallic materials toward dielectric values and raises low roughness values so diffuse bounce remains readable. This is not a raw-material reference viewer for the source glTF.
- GUI changes are not persisted. Reloading or revisiting a page restores that scene's defaults.
- The application expects to be served from the site root because its entry points and Sponza asset URL use root-relative paths.

## Project structure

| Path | Purpose |
| --- | --- |
| `index.html`, `src/main.js` | Sponza entry point, sky and sun controls, model loading, and display settings. |
| `simple.html`, `src/simple.js` | Afterimage Court entry point and interaction loop. |
| `src/simple_scene.js` | Procedural court geometry, materials, and lighting. |
| `ballpool.html`, `src/ballpool.js` | Ball Pool entry point, input handling, lighting, and GI updates. |
| `src/ballpool_scene.js` | Physics world, instanced ball rendering, collision walls, and pointer impulses. |
| `src/gi_settings.js` | Shared GI defaults, setters, and lil-gui controls. |
| `src/post_settings.js` | Shared GTAO, TRAA, and bloom pipeline. |
| `src/TRAANode.js` | Local temporal reprojection anti-aliasing implementation. |
| `src/probe_helpers.js` | Optional instanced visualization of the active probe grid. |
| `public/Sponza/` | Bundled Sponza glTF, textures, screenshots, source notes, and licensing information. |

## Available scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server, normally on port 5173. |
| `npm run build` | Build all three HTML entry points into `dist/`. |
| `npm run preview` | Serve an existing production build locally. Run `npm run build` first. |

## Sponza asset

The bundled model is loaded from `public/Sponza/glTF/Sponza.gltf`. See [`public/Sponza/README.md`](public/Sponza/README.md) for the model's sources, processing notes, attribution, and licensing information.

## Credits

- [`speedball-gi`](https://github.com/cl0nazepamm/speedball) provides the WebGPU DDGI and local-reflection implementation.
- The Sponza scene is adapted from the upstream SPEEDBALL GI demo.
- The Ball Pool concept is based on the [Three.js WebGPU SSGI Ball Pool example](https://github.com/mrdoob/three.js/blob/master/examples/webgpu_postprocessing_ssgi_ballpool.html), with [`@perplexdotgg/bounce`](https://www.npmjs.com/package/@perplexdotgg/bounce) for physics and SPEEDBALL GI for world-space indirect lighting.
