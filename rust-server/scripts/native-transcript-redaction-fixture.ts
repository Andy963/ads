import { legacyModulePath } from "./legacy-module-path.ts";

async function main() {
  const { redactNativeTranscriptText } = await import(
    legacyModulePath("server/state/nativeTranscriptStore.ts")
  );
  const cases = [
    "Authorization: Bearer abc123",
    "key sk-1234567890",
    "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    "aws AK" + "IAABCDEFGHIJKLMNOP",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature",
    "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    "https://user:password@example.com/path",
    "api_key=plain-secret",
    "clientSecret: \"camel-secret\"",
    "password = \"quoted-secret\"",
    "{\"password\":\"abc\",\"token\":\"x\",\"ok\":\"Bearer abc\"}",
    "{\"authorization\":\"Bearer nested\",\"safe\":\"keep\"}",
    "{\"broken\":",
    "supersecret and abc and x",
    "line one\nabc\nline three",
  ];

  const redactions = ["supersecret", "abc", "x"];
  process.stdout.write(`${JSON.stringify({ cases: cases.map((value) => redactNativeTranscriptText(value, redactions)) })}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
