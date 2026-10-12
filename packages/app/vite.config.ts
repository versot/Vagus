import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: "index.html" } } },
  // The package's browser entry uses document; Markdown also runs in workers.
  // Its default entry is the equivalent pure character-entity lookup table.
  resolve: {
    alias: {
      "decode-named-character-reference": require.resolve("decode-named-character-reference"),
      // React disables Profiler callbacks in ordinary production builds. Keep the
      // profiling runtime opt-in so diagnostics can measure real desktop commits.
      ...(process.env.VAGUS_PROFILE_REACT === "1"
        ? { "react-dom/client": require.resolve("react-dom/profiling") }
        : {}),
    },
  },
  server: { port: 5173, strictPort: true },
  clearScreen: false,
});
