/**
 * ProjectProfiler — 启动时扫描工作目录，生成项目画像
 * 注入 system prompt，避免 Agent 浪费 token 在 fs_list 探索上
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectProfile } from "../types.js";

export class ProjectProfiler {
  constructor(private workingDir: string) {}

  scan(): ProjectProfile | null {
    try {
      const entries = readdirSync(this.workingDir, { withFileTypes: true });
      const topDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      const topFiles = entries.filter((e) => e.isFile()).map((e) => e.name);

      const profile: ProjectProfile = {
        type: "unknown",
        pkgManager: "",
        testFramework: "",
        entryFile: "",
        topDirs: topDirs.slice(0, 12), // cap to avoid overloading prompt
        keyFiles: [],
      };

      // Detect project type by key files
      if (topFiles.includes("package.json")) {
        profile.type = "Node/TypeScript";
        try {
          const pkgRaw = readFileSync(resolve(this.workingDir, "package.json"), "utf-8");
          const pkg = JSON.parse(pkgRaw);

          // Package manager
          if (existsSync(resolve(this.workingDir, "pnpm-lock.yaml"))) profile.pkgManager = "pnpm";
          else if (existsSync(resolve(this.workingDir, "yarn.lock"))) profile.pkgManager = "yarn";
          else profile.pkgManager = "npm";

          // Test framework
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps?.vitest) profile.testFramework = "vitest";
          else if (allDeps?.jest) profile.testFramework = "jest";
          else if (allDeps?.mocha) profile.testFramework = "mocha";

          // Entry
          profile.entryFile = pkg.main ?? "";
        } catch {
          /* ignore parse errors */
        }
      } else if (topFiles.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) {
        profile.type = "C#/.NET";
        profile.pkgManager = "nuget";
      } else if (topFiles.includes("Cargo.toml")) {
        profile.type = "Rust";
        profile.pkgManager = "cargo";
      } else if (topFiles.includes("go.mod")) {
        profile.type = "Go";
        profile.pkgManager = "go";
      } else if (topFiles.includes("requirements.txt") || topFiles.includes("pyproject.toml")) {
        profile.type = "Python";
        profile.pkgManager = topFiles.includes("pyproject.toml") ? "pip/poetry" : "pip";
        if (topFiles.includes("pyproject.toml")) {
          try {
            const pyr = readFileSync(resolve(this.workingDir, "pyproject.toml"), "utf-8");
            if (pyr.includes("pytest")) profile.testFramework = "pytest";
            else if (pyr.includes("unittest")) profile.testFramework = "unittest";
          } catch {
            /* ignore */
          }
        }
      }

      // Key files (limit to 8)
      const keyFilePatterns = [
        "package.json",
        "tsconfig.json",
        "vitest.config.ts",
        "vite.config.ts",
        "README.md",
        "AGENTS.md",
        ".gitignore",
        ".env.example",
        "docker-compose.yml",
        "Dockerfile",
        "Makefile",
        "Cargo.toml",
        "go.mod",
        "requirements.txt",
        "pyproject.toml",
        "setup.py",
        ".eslintrc*",
        "prettier.config.*",
        ".prettierrc*",
      ];
      profile.keyFiles = topFiles
        .filter((f) =>
          keyFilePatterns.some((p) => {
            const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
            return new RegExp(`^${escaped}$`).test(f);
          }),
        )
        .slice(0, 8);

      return profile;
    } catch {
      return null;
    }
  }
}
