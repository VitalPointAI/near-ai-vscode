// Keeps a test process inside the address-space cap the tests run under (ulimit -v 6000000 with a 1536 MB heap), imported first by the team harness
// and the fake NEAR server so it runs before any fetch.
// V8 reserves the whole growth range of a WebAssembly memory when the memory is made, and for a memory that declares no maximum that range is
// --wasm-max-mem-pages pages: 65536, so 4 GiB of address space with nothing behind it. Node's fetch makes undici's llhttp parser on its first
// connection, so every test file that talks to the fake NEAR server reserved those 4 GiB. Under the 6 GB cap that left about 270 MB for the heap
// and the rest of the process, and teamBoardView.test.js died at its 18th test with "Committing semi space failed ... JavaScript heap out of memory"
// while its heap held under 50 MB and its RSS was 165 MB (.planning/debug/team-board-view-test-oom.md).
// Lowering the page limit before the first fetch makes that reservation 128 MiB. The parser needs far less: it reads a 4 MB response with 16 pages.
// Nothing in the extension changes; VS Code runs it with no address-space cap, where the reservation costs nothing.
// The file has no .test suffix on purpose so the test glob does not run it as a suite.
import { setFlagsFromString } from 'node:v8';

/** The most 64 KiB pages one WebAssembly memory may grow to in a test process (128 MiB). */
export const WASM_MAX_MEMORY_PAGES = 2048;

setFlagsFromString(`--wasm-max-mem-pages=${WASM_MAX_MEMORY_PAGES}`);
