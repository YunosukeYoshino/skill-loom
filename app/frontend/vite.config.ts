import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

/**
 * Vite を直接開いたときに /api/* が SPA index（HTML 200）へ落ちないようにする。
 * 正規の入口は Hono 公開ポート（`skill-loom ui --dev`）。Hono が /api を処理し、
 * それ以外だけを Vite へプロキシする。
 */
function rejectDirectApi(): Plugin {
  return {
    name: "skill-loom-reject-direct-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ""
        if (!url.startsWith("/api/") && url !== "/api") {
          next()
          return
        }
        res.statusCode = 502
        res.setHeader("Content-Type", "application/json; charset=utf-8")
        res.end(
          JSON.stringify({
            message:
              "API is served by Skill Loom UI (skill-loom ui / --dev), not the Vite port. Open the public UI URL printed at startup.",
          }),
        )
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), rejectDirectApi()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
})
