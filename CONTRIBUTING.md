# Contributing to Anime Upscaler

Thanks for your interest in improving Anime Upscaler! This project is a small,
dependency-free Chrome extension (vanilla JS + WGSL, no build step), so the
workflow below is intentionally lightweight.

By participating in this project, you agree to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## 1. Fork and clone

1. Fork the repository by clicking **Fork** at the top of the
   [GitHub page](https://github.com/ThaminduMiuranda/anime-upscaler-webgpu).
2. Clone your fork locally:

   ```bash
   git clone https://github.com/<your-username>/anime-upscaler-webgpu.git
   cd anime-upscaler-webgpu
   ```
3. Load it as an unpacked extension so you can test changes live — see
   [Run it locally](README.md#-run-it-locally-no-chrome-web-store-required)
   in the README.

## 2. Create a feature branch

Branch off `main` with a short, descriptive name prefixed by the change type:

```bash
git checkout -b feat/split-compare-slider
git checkout -b fix/drm-detection-iframe
git checkout -b docs/update-readme-badges
```

Common prefixes: `feat/`, `fix/`, `docs/`, `refactor/`, `perf/`, `chore/`.

## 3. Development workflow

This project has no automated test suite yet — verification is manual, in a
real Chromium-based browser:

- Reload the extension at `chrome://extensions` after every change
  (click the ↻ icon on its card), then re-check the behavior you touched.
- Test on at least one real page with a `<video>` element, with the popup's
  stats overlay (`Show stats overlay`) turned on to confirm frames are still
  rendering at a sane resolution/fps.
- If you touch `src/content.js`, also check the edge cases it already
  handles: small/thumbnail videos, paused video, DRM video (should be
  skipped, not crashed on), and cross-origin video without CORS.
- If you touch `src/renderer.js` or `src/shaders.js`, check
  `chrome://gpu` and the console for WebGPU validation errors.
- If you change icon artwork, regenerate it rather than hand-editing PNGs:

  ```bash
  pip install pillow
  python tools/generate_icons.py
  ```

Keep code quality consistent with the existing style:

- Match the formatting already in the file you're editing (2-space indent,
  semicolons, single quotes).
- Keep the project dependency-free and build-step-free — no bundlers, no
  npm packages, no transpilation.
- Keep the extension's permissions minimal. Don't add network requests,
  analytics, remote code, or new permissions unless the feature genuinely
  requires it, and call that out explicitly in your PR.
- Prefer small, focused changes over broad refactors in the same PR.

### Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(optional scope): <short, imperative summary>

[optional body explaining the why, not the what]
```

Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `chore`, `style`, `test`.

Examples:

```
feat(popup): add a one-click reset for custom sliders
fix(content): skip videos inside closed shadow roots
docs(readme): correct keyboard shortcut for compare mode
```

## 4. Submit a pull request

1. Push your branch to your fork and open a PR against this repository's
   `main` branch.
2. Give the PR a clear, descriptive title (ideally following the same
   Conventional Commits style as above).
3. In the description, include:
   - **What** changed and **why**.
   - **How you tested it** (which site/video, browser version, GPU if
     relevant to a rendering change).
   - Any new permissions, dependencies, or user-visible behavior changes.
   - Linked issue(s), if any (e.g. `Closes #12`).
4. Keep the PR scoped to one logical change — smaller PRs are easier to
   review and land faster.
5. Be responsive to review feedback; a maintainer may ask for small changes
   before merging.

## Reporting bugs or suggesting features

Please open a [GitHub issue](https://github.com/ThaminduMiuranda/anime-upscaler-webgpu/issues)
with steps to reproduce (for bugs) or a clear description of the use case
(for feature requests), including your browser version and GPU where relevant.
