# 融画

可游玩的原创 Three.js 原型。这个仓库只包含游戏源代码、必要的构建文件和 WASM 求解器，不包含研究档案、第三方安装包、截图合集或聊天记录。

## 本地试玩

```sh
npm ci
npm run build
```

使用浏览器打开 `dist/index.html`。材料实验入口为 `dist/index.html?lab=fluid`。

## 发布到 GitHub Pages

把此目录推送到自己的 GitHub 仓库默认分支 `main`。仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。工作流会运行测试、生成自包含单文件并部署到 Pages。

部署网址为 `https://<用户名>.github.io/<仓库名>/`，肖像关使用 `?level=seaside-painter`，材料实验使用 `?lab=fluid`。

## 命令

- `npm test` 运行规则、材料与 WASM 回归。
- `npm run build` 生成可离线游玩的 `dist/index.html`。
- `npm run bench:particles` 比较 JavaScript 与 WASM 的固定步数 CPU 耗时。
- `npm run build:wasm` 使用 Zig 重编粒子求解模块，需要本机安装 Zig。

Pages 工作流直接使用已随源文件保存的 WASM 二进制，无需在 GitHub runner 安装 Zig。
