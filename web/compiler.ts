// Bun bundler plugin: run the React Compiler (babel-plugin-react-compiler) over the
// .tsx components. Bun's native transpiler doesn't run Babel, so RC needs this pass.
// It ONLY applies the compiler transform — JSX/TS are left intact for Bun to finish.
import type { BunPlugin } from "bun";
import * as babel from "@babel/core";

export const reactCompiler: BunPlugin = {
  name: "react-compiler",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text();
      const result = await babel.transformAsync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["jsx", "typescript"] },
        plugins: [["babel-plugin-react-compiler", { target: "19" }]],
        sourceMaps: "inline",
      });
      return { contents: result?.code ?? source, loader: "tsx" };
    });
  },
};
