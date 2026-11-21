import type { ElectrobunConfig } from "electrobun";

const macUsesCef = process.platform === "darwin";

const config: ElectrobunConfig = {
  app: {
    name: "Kip",
    identifier: "ai.kip.desktop",
    version: "0.2.5",
    description: "A quiet desktop coding agent built with Electrobun and Pi",
  },
  scripts: {
    // Our own rcedit pass: Electrobun's icon embedding cannot resolve its
    // bundled rcedit, so Windows binaries keep the default icon without this.
    postBuild: "scripts/patch-windows-icons.ts",
    postWrap: "scripts/patch-macos-launcher.ts",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
    },
    mac: {
      bundleCEF: true,
      defaultRenderer: macUsesCef ? "cef" : "native",
    },
    linux: {
      bundleCEF: false,
      icon: "assets/icon.png",
    },
    win: {
      bundleCEF: false,
      icon: "assets/icon.ico",
    },
  },
};

export default config;
