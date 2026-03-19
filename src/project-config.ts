import fs from "node:fs";
import path from "node:path";
import { PROJECT_CONFIG_FILE } from "./config.js";
import type { MyCliConfig, SessionProfile } from "./types.js";

export function loadProjectConfig(cwd: string): MyCliConfig {
  const configPath = path.join(cwd, PROJECT_CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(configPath, "utf8")) as MyCliConfig;
}

export function getProfile(config: MyCliConfig, name?: string): SessionProfile | undefined {
  if (!name) {
    return undefined;
  }

  return config.profiles?.[name];
}

export function getProjectConfigPath(cwd: string): string {
  return path.join(cwd, PROJECT_CONFIG_FILE);
}

export function writeProjectConfig(cwd: string, config: MyCliConfig): string {
  const configPath = getProjectConfigPath(cwd);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

export function createDefaultConfig(cwd: string): MyCliConfig {
  return {
    profiles: {
      default: {
        cwd,
      },
    },
  };
}

export function upsertProfile(
  cwd: string,
  name: string,
  profile: SessionProfile,
): string {
  const config = loadProjectConfig(cwd);
  const profiles = {
    ...(config.profiles ?? {}),
    [name]: profile,
  };

  return writeProjectConfig(cwd, {
    ...config,
    profiles,
  });
}

export function removeProfile(cwd: string, name: string): string {
  const config = loadProjectConfig(cwd);
  const profiles = { ...(config.profiles ?? {}) };
  delete profiles[name];

  return writeProjectConfig(cwd, {
    ...config,
    profiles,
  });
}

export function renameProfile(cwd: string, name: string, nextName: string): string {
  const config = loadProjectConfig(cwd);
  const profiles = { ...(config.profiles ?? {}) };
  const profile = profiles[name];

  if (!profile) {
    throw new Error(`Profile '${name}' not found.`);
  }

  delete profiles[name];
  profiles[nextName] = profile;

  return writeProjectConfig(cwd, {
    ...config,
    profiles,
  });
}

export function importProjectConfig(
  cwd: string,
  filePath: string,
  replace: boolean,
): string {
  const imported = JSON.parse(fs.readFileSync(filePath, "utf8")) as MyCliConfig;
  const current = replace ? {} : loadProjectConfig(cwd);
  const profiles = {
    ...(current.profiles ?? {}),
    ...(imported.profiles ?? {}),
  };

  return writeProjectConfig(cwd, {
    ...current,
    ...imported,
    profiles,
  });
}
