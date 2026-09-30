import type { NextConfig } from "next"

// Next 16 ya no ejecuta ESLint dentro de `next build` (y quitó la opción
// `eslint` de NextConfig): el lint corre solo como step propio en CI
// (`npm run lint` → `eslint .`).
const nextConfig: NextConfig = {}

export default nextConfig
