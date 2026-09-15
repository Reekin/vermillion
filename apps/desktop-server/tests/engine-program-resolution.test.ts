import { describe, expect, it } from "vitest";
import {
  resolveEngineProgramCommand,
  resolveEngineSpawnCommand,
  type EngineProgramRule
} from "../src/engine-program-resolution.js";
import { codexProgram } from "../src/engines/codex/program.js";

const secondEngineProgram: EngineProgramRule = {
  environmentVariables: ["VERMILLION_SECOND_BIN", "SECOND_BIN"],
  windowsDefault: "second.cmd",
  default: "second",
  defaultArgs: ["serve"],
  explicitArgs: ["serve", "--stdio"]
};

describe("resolveEngineProgramCommand", () => {
  it("prefers a custom path over configured and environment paths", () => {
    expect(
      resolveEngineProgramCommand("codex", {
        program: codexProgram,
        customPath: "C:\\custom\\codex.exe",
        configuredPath: "C:\\configured\\codex.exe",
        env: {
          VERMILLION_CODEX_BIN: "C:\\env\\codex.exe"
        },
        platform: "win32"
      })
    ).toEqual({
      path: "C:\\custom\\codex.exe",
      source: "custom",
      args: ["app-server"],
      found: false
    });
  });

  it("reports the first environment variable that resolved Codex", () => {
    expect(
      resolveEngineProgramCommand("codex", {
        program: codexProgram,
        env: {
          CODEX_BIN: "C:\\tools\\codex.exe",
          CODEX_PATH: "C:\\older\\codex.exe"
        },
        platform: "win32"
      })
    ).toEqual({
      path: "C:\\tools\\codex.exe",
      source: "environment",
      environmentVariable: "CODEX_BIN",
      args: ["app-server"],
      found: false
    });
  });

  it("skips blank environment values and keeps Pi defaults for configured paths", () => {
    expect(
      resolveEngineProgramCommand("codex", {
        program: codexProgram,
        env: {
          VERMILLION_CODEX_BIN: " ",
          CODEX_BIN: "C:\\tools\\codex.exe"
        },
        platform: "win32"
      })
    ).toMatchObject({
      path: "C:\\tools\\codex.exe",
      environmentVariable: "CODEX_BIN"
    });
    expect(
      resolveEngineProgramCommand("second", {
        program: secondEngineProgram,
        configuredPath: "second.cmd",
        env: {},
        platform: "win32"
      })
    ).toEqual({
      path: "second.cmd",
      source: "configured",
      args: ["serve"],
      found: false
    });
  });

  it("falls back to the engine id when no rule is registered", () => {
    expect(
      resolveEngineProgramCommand("second", {
        env: {},
        platform: "win32"
      })
    ).toEqual({
      path: "second",
      source: "default",
      args: [],
      found: false
    });
  });

  it("runs Windows command shims through cmd.exe", () => {
    expect(
      resolveEngineSpawnCommand(
        "C:\\Program Files\\Codex\\codex.cmd",
        ["app-server"],
        {
          platform: "win32",
          comspec: "C:\\Windows\\System32\\cmd.exe"
        }
      )
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "\"C:\\Program Files\\Codex\\codex.cmd\" app-server"
      ]
    });
  });

  it("reports whether the resolved program exists", () => {
    const env = { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" };
    expect(
      resolveEngineProgramCommand("second", {
        program: secondEngineProgram,
        customPath: process.execPath,
        env,
        platform: "win32"
      })
    ).toMatchObject({ found: true, resolvedPath: process.execPath });
    expect(
      resolveEngineProgramCommand("second", {
        program: secondEngineProgram,
        configuredPath: "C:\\tools\\missing.cmd",
        env,
        platform: "win32"
      })
    ).toEqual({
      path: "C:\\tools\\missing.cmd",
      source: "configured",
      args: ["serve"],
      found: false
    });
    expect(
      resolveEngineProgramCommand("second", {
        program: secondEngineProgram,
        env: { PATH: "C:\\tools", PATHEXT: ".EXE" },
        platform: "win32"
      })
    ).toMatchObject({ path: "second.cmd", source: "default", found: false });
  });
});
