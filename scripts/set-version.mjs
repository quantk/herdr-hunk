import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const nextVersion = process.argv[2];
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

if (!nextVersion || !stableSemver.test(nextVersion)) {
  throw new Error("Usage: npm run release:prepare -- <major.minor.patch>");
}

const packagePath = new URL("../package.json", import.meta.url);
const lockPath = new URL("../package-lock.json", import.meta.url);
const manifestPath = new URL("../herdr-plugin.toml", import.meta.url);
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const currentVersion = packageJson.version;

function semverParts(version) {
  return version.split(".").map(Number);
}

function compareVersions(left, right) {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

if (!stableSemver.test(currentVersion)) {
  throw new Error(`Current package version is not stable SemVer: ${currentVersion}`);
}
if (compareVersions(nextVersion, currentVersion) <= 0) {
  throw new Error(
    `New version ${nextVersion} must be greater than ${currentVersion}.`,
  );
}

packageJson.version = nextVersion;
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

if (existsSync(lockPath)) {
  const packageLock = JSON.parse(readFileSync(lockPath, "utf8"));
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }
  writeFileSync(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
}

const manifest = readFileSync(manifestPath, "utf8");
const updatedManifest = manifest.replace(
  /^version\s*=\s*"[^"]+"$/m,
  `version = "${nextVersion}"`,
);
if (updatedManifest === manifest) {
  throw new Error("Cannot update version in herdr-plugin.toml.");
}
writeFileSync(manifestPath, updatedManifest);

process.stdout.write(
  `Prepared version ${nextVersion}. Review the diff, commit it, then tag v${nextVersion}.\n`,
);
