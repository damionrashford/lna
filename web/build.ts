// Production build: bundle index.html (+ React/TSX + Tailwind) into static assets
// GitHub Pages can serve. Plugins only load through the Bun.build API, not `bun build` CLI.
import tailwind from "bun-plugin-tailwind";
import { reactCompiler } from "./react-compiler-plugin";

// Pages serves the project site under /lna/, so assets must be prefixed with it.
// Override for a root deploy or local preview: PUBLIC_PATH=/ bun run build
const publicPath = Bun.env.PUBLIC_PATH ?? "/lna/";

const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  minify: true,
  sourcemap: "linked",
  publicPath,
  plugins: [reactCompiler, tailwind],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`built ${result.outputs.length} files → dist/ (publicPath ${publicPath})`);
