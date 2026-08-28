import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Only this repo's tests: each patch directory's patch.test.mjs plus
		// script tests. The default include sweeps the upstream-pi checkout
		// that CI's upstream-main job clones into this repo, running
		// upstream's own suite, which assumes its own cwd and fails.
		include: ["*/patch.test.mjs", "scripts/*.test.mjs"],
	},
});
