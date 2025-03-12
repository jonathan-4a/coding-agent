import { runApp } from "./app";
import type { AIProvider } from "./ai/contracts";

export { runApp } from "./app";

if (import.meta.main) {
  const providerModulePath = Bun.env.AI_PROVIDER_MODULE ?? "./ai/provider";
  try {
    const providerModule: { createProvider?: () => AIProvider } = await import(providerModulePath);
    if (!providerModule.createProvider) {
      throw new Error(`The module must export createProvider(): AIProvider.`);
    }
    await runApp(providerModule.createProvider());
  } catch (error) {
    console.error(
      `Could not load an AI provider from ${providerModulePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("Set AI_PROVIDER_MODULE to a module that exports createProvider(), or import runApp() from your own entrypoint.");
    process.exitCode = 1;
  }
}
