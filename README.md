# Coding Agent

Coding Agent is a terminal coding assistant built with TypeScript and Bun. It gives an AI model access to a project through three tools: read a file, run a shell command, or fetch text from a web page. Tool results return to the conversation so the model can use them in its answer.

## Run

Install dependencies with Bun:

```sh
bun install
```

The standalone entrypoint loads a provider adapter from `src/ai/provider.ts`. This repository does not include a vendor-specific adapter. Set `AI_PROVIDER_MODULE` to load an adapter from another location, or call `runApp(provider)` from your own entrypoint. The adapter must export `createProvider()` and implement `AIProvider` from `src/ai/contracts.ts`.

Start the program from the directory you want the tools to use:

```sh
bun run src/main.ts
```

## Tools

The `read` tool reads UTF-8 files under the project directory, including a check that symlinks stay inside it. `bash` asks before running a command, stops it after 30 seconds, and caps captured output at 100 KB per stream. `webfetch` retrieves text from public HTTP and HTTPS hosts, follows at most three redirects, and caps each response at 200 KB. It blocks private or reserved network addresses, including after DNS lookup and redirects.

Each request can use up to 20 model turns. Conversation history stays in memory and is cleared when the program exits.
