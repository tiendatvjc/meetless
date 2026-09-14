import { runLinuxCaptureHelper } from "./capture-helper-linux.js";

const testChunkPayloadBytes = Number(process.env.MEETLESS_CHUNK_PAYLOAD_BYTES);
process.exitCode = await runLinuxCaptureHelper({
  args: process.argv.slice(2),
  chunkPayloadBytes: Number.isSafeInteger(testChunkPayloadBytes) && testChunkPayloadBytes > 0
    ? testChunkPayloadBytes
    : undefined,
});
