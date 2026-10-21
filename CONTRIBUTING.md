# Contributing

Contributions can improve instructions, fix a demo or add a focused workflow. Check the [examples table](README.md#examples) first and improve the existing example when it already covers your use case. Follow [AGENTS.md](AGENTS.md) for the full example requirements.

## Run an example locally

Use Node.js 22.3 or newer. Clone the repository, or your fork if you plan to submit a pull request, then run:

```sh
git clone https://github.com/flinker-app/ifc-viewer-examples.git
cd ifc-viewer-examples
npm ci
npm run dev
```

Open the local address printed in the terminal and append an example path, such as `/examples/component-lookup/index.html`. Keep an internet connection available for the published SDK and sample files.

## Make a change

1. Edit `examples/<name>/index.html`. For a new workflow, start from the closest existing example and give it its own folder. Keep one clear task and audience per example.
2. Keep JavaScript, CSS, configuration, metadata, instructions and notices in that HTML file. Import the published SDK directly from the pinned CDN URL in `viewer-sdk.config.json`; keep model files and SDK implementation out of the repository.
3. Update the visible instructions and the `example-guide` and `example-notices` templates as needed. Preserve source attribution and license links for assets you use.
4. Run `npm run generate` to update the catalog, README table and SEO tags. Make metadata changes in the HTML rather than editing generated files.
5. For visual changes or a new example, run `npm run previews -- --sample <name>` to create its preview, then inspect the demo at desktop and mobile sizes.

## Verify and submit

Run these checks before submitting:

```sh
npm run check
npm test
npm run build
```

For changes to demo behavior or layout, also run the browser checks after building:

```sh
npm run test:browser -- --isolated
```

Open a pull request describing the user-facing change, the affected example and how you verified it. Include desktop and mobile screenshots for layout changes.

If you are reporting a problem instead, [open an issue](https://github.com/flinker-app/ifc-viewer-examples/issues) with the demo link, steps to reproduce, expected behavior and what happened. Include your browser and device when relevant.
