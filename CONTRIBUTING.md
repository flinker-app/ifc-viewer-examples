# Contributing

Follow [AGENTS.md](AGENTS.md) for example requirements. Reuse an existing example when it covers the same workflow.

Use Node.js 22.3 or newer. Run `npm ci`, then `npm run dev`. Open `/examples/<name>/index.html` on the local server.

1. Edit the example HTML, including its metadata, instructions and notices.
2. Run `npm run generate` to update the catalog, README table and SEO tags.
3. For visual changes, run `npm run previews -- --sample <name>` and inspect desktop and mobile layouts.
4. Run the checks below before submitting. Describe the change and verification in your pull request.

```sh
npm run check
npm test
npm run build
npm run test:browser -- --isolated
```
