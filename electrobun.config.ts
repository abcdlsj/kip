import type { ElectrobunConfig } from "electrobun";

const macUsesCef = process.platform === "darwin";

const config: ElectrobunConfig = {
  app: {
    name: "Kip",
    identifier: "ai.kip.desktop",
    version: "0.2.8",
    description: "A quiet desktop assistant built with Electrobun and Pi",
  },
  scripts: {
    // Two passes in one hook: our own rcedit run (Electrobun's icon embedding
    // cannot resolve its bundled rcedit) and the macOS launcher patch for the
    // real app bundle that goes inside the self-extracting tarball.
    postBuild: "scripts/post-build.ts",
    postWrap: "scripts/patch-macos-launcher.ts",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      // Plugin pages sit at views/plugins/<id>/; their HTML points two levels up,
      // so their assets land beside the main view's, not inside the page folder.
      "dist-plugins/plugins": "views/plugins",
      "dist-plugins/assets": "views/assets",
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
