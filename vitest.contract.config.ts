import { defineConfig } from "vitest/config"

// The agent contract (src/test/contract): every pinned adapter, installed
// from npm and run without a sign-in. Kept out of `yarn test`.
export default defineConfig({
  test: {
    include: ["src/test/contract/**/*.contract.ts"],
    environment: "node",
    // Agents install and start one at a time.
    fileParallelism: false,
  },
})
