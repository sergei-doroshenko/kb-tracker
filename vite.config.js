import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: './' — чтобы сборка работала из любого пути на S3
export default defineConfig({
  plugins: [react()],
  base: "./",
});
