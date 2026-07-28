import { existsSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const manifest = readFileSync(
  new URL("../herdr-plugin.toml", import.meta.url),
  "utf8",
);
const manifestVersion = manifest.match(/^version\s*=\s*"([^"]+)"$/m)?.[1];
const expectedVersion = process.argv[2];

if (!manifestVersion) {
  throw new Error("Cannot read version from herdr-plugin.toml.");
}
if (packageJson.version !== manifestVersion) {
  throw new Error(
    `Version mismatch: package.json=${packageJson.version}, herdr-plugin.toml=${manifestVersion}.`,
  );
}
const lockPath = new URL("../package-lock.json", import.meta.url);
if (existsSync(lockPath)) {
  const packageLock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (
    packageLock.version !== packageJson.version ||
    packageLock.packages?.[""]?.version !== packageJson.version
  ) {
    throw new Error(
      `Version mismatch: package.json=${packageJson.version}, package-lock.json=${packageLock.version}, package-lock root=${packageLock.packages?.[""]?.version}.`,
    );
  }
}
if (expectedVersion && packageJson.version !== expectedVersion) {
  throw new Error(
    `Tag/version mismatch: expected ${expectedVersion}, project=${packageJson.version}.`,
  );
}

process.stdout.write(`Version ${packageJson.version} is consistent.\n`);
