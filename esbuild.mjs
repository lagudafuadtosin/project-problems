import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  target: "node18",
  minify: process.argv.includes("--production"),
  sourcemap: !process.argv.includes("--production"),
  outfile: "dist/extension.js",
});
console.log("built dist/extension.js");
