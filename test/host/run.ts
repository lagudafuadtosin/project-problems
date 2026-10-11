// Starts a real VS Code with the extension loaded and the framework fixtures
// open, and runs test/host/suite.ts inside it. VS Code is downloaded once into
// .vscode-test (git-ignored).
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main() {
  // Bundled into .test-build, so the repo is one folder up.
  const root = path.resolve(__dirname, "..");
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, ".test-build", "host-suite.cjs"),
      launchArgs: [
        path.join(root, "test", "host", "frameworks.code-workspace"),
        "--disable-extensions",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
      ],
    });
  } catch (err) {
    console.error("host tests failed", err);
    process.exit(1);
  }
}

void main();
