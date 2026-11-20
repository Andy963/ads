import { extractRelatedContexts } from "../../ts-server/server/reviewer/contextExtractor.js";

const [repoPath, baseCommit, headCommit] = process.argv.slice(2);
if (!repoPath || !baseCommit || !headCommit) {
  throw new Error("usage: context-extractor-fixture <repo> <base> <head>");
}
process.stdout.write(JSON.stringify(extractRelatedContexts(repoPath, baseCommit, headCommit)));
