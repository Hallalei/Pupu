---
name: release
description: 发版：把核对过的改动推上 main，再发云端、电脑 App、TestFlight、官网里改到的那几端。触发：改动核对完要上线；「发版」「部署」「上 TestFlight」。
---

# 发版

改动先按 `verify-pupu` 核对过，再走这里。顺序固定：版本号 → 体检 → 推 main → 云端 → 电脑 App → iOS → 官网，只做体检列出的那几端。下面的 `$R` 是 `.claude/skills/release/scripts`，`$SP` 是本次会话的 scratchpad，命令在仓库根目录跑。耗时的命令放后台，输出重定向到 `$SP` 里的文件。

账号标识在本机的 `~/.config/pupu/release.env`（`ASC_PROFILE`、`PUPU_ASC_APP`、`PUPU_TF_INTERNAL`、`PUPU_TF_EXTERNAL`、`PUPU_TF_EXTERNAL_ID`），用到 `asc` 前先 `source` 它。文件不在就请用户给这几个值，写进去再继续。

## 1. 版本号和体检

改到 `apps/desktop` 或 `apps/cloud/bridge` 时，电脑 App 版本号加一并提交：

```bash
(cd apps/desktop && npm version <新版本> --no-git-tag-version)
```

Squirrel 只比「和本机一样不一样」，版本号只能往上走。

```bash
node $R/preflight.mjs
```

完成标准：每行都是 `ok`。它同时列出这次要发哪几端。

## 2. 推 main

```bash
git push origin HEAD:main > $SP/push.log 2>&1; echo $?
```

`git push` 的输出只重定向到文件：这台机器上接管道会被杀（exit 137）。完成标准：`git rev-parse origin/main` 等于 `HEAD`。

## 3. 云端

```bash
(cd apps/cloud && npm run deploy > $SP/deploy.log 2>&1); grep "Current Version ID" $SP/deploy.log
(cd apps/cloud && npx wrangler deployments list | tail -20)
```

记下新旧两个版本号。完成标准：从 `https://app.getpupu.com/` 引的 JS 里 grep 到这次改动才有的一段文字，或新接口回了预期的状态码。

- 部署后头几分钟，新加的 DO 方法可能报 `RPC receiver does not implement`：旧实例还没换，等几分钟再测，代码照旧。
- 审核用的 `pupu-review` 只在用户点名时更新：从 `dist/pupu/wrangler.json` 复制一份，改名并去掉 `routes` 再部署。直接加 `--name` 会把 app.getpupu.com 挪过去。

## 4. 电脑 App

先云端后 App：窗口加载的是云端网页。

```bash
(cd apps/desktop && npm run dist > $SP/dist.log 2>&1)    # 后台，公证要 15 分钟以上，app 和 dmg 各公证一次
(cd apps/desktop && npm run release)
node $R/check-download.mjs
```

完成标准：`check-download.mjs` 三行都是 `ok`。

然后把这台 Mac 换成新版，只动 Pupu 自己的进程：

1. `osascript -e 'tell application id "com.leizi.pupu.desktop" to quit'`。
2. 把刚发的 zip 用 `ditto -x -k` 解到 `$SP`，`spctl -a -vv` 显示 `Notarized Developer ID`。
3. 旧的 `/Applications/Pupu.app` 挪进 `$SP`，`ditto` 放进新版。
4. `open -g /Applications/Pupu.app --args --tray`。

完成标准：`~/Library/Logs/Pupu/main.log` 出现「Pupu <新版本> 启动」。传完 R2 再装本机：清单还指着旧版时装新版，会被自动更新换回去。

## 5. iOS

改到 `apps/ios` 才做。构建号用当前时间：

```bash
source ~/.config/pupu/release.env
TEAM=$(/usr/libexec/PlistBuddy -c 'Print IDEProvisioningTeamByIdentifier' ~/Library/Preferences/com.apple.dt.Xcode.plist | grep -m1 -oE 'teamID = [A-Z0-9]+' | awk '{print $3}')
BUILD=$(date +%Y%m%d%H%M)
cat > $SP/ExportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>method</key><string>app-store-connect</string><key>signingStyle</key><string>automatic</string><key>teamID</key><string>$TEAM</string></dict></plist>
EOF
xcodebuild archive -project apps/ios/Pupu.xcodeproj -scheme Pupu -configuration Release -destination 'generic/platform=iOS' \
  -archivePath $SP/Pupu.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM=$TEAM CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION=$BUILD > $SP/archive.log 2>&1 \
  && xcodebuild -exportArchive -archivePath $SP/Pupu.xcarchive -exportPath $SP/ipa -exportOptionsPlist $SP/ExportOptions.plist -allowProvisioningUpdates >> $SP/archive.log 2>&1
asc builds upload --app $PUPU_ASC_APP --ipa $SP/ipa/Pupu.ipa > $SP/upload.log 2>&1
```

每 15 秒看一次 `asc builds list --app $PUPU_ASC_APP --limit 3`，等这个构建号的 `processingState` 变成 `VALID`，记下它的 `id`。

内部组走命令行：

```bash
asc builds add-groups --build-id <id> --group "$PUPU_TF_INTERNAL"
```

外部组走 ego lite 里的 App Store Connect 网页（这把密钥加外部组回 403）：开一个 TaskSpace，打开 `https://appstoreconnect.apple.com/apps/$PUPU_ASC_APP/testflight/groups/$PUPU_TF_EXTERNAL_ID`，「构建版本」旁的加号 → 选这个构建 → 下一步 →「测试内容」填一句这版测什么 →「提交以供审核」。审核资料沿用已有的。登录过期时 handOff 给用户本人登录。

完成标准：

```bash
asc builds build-beta-detail view --build-id <id> | grep -oE '"(internal|external)BuildState":"[A-Z_]+"'
```

内部是 `IN_BETA_TESTING`，外部是 `IN_BETA_TESTING` 或 `WAITING_FOR_BETA_REVIEW`。

## 6. 官网

改到 `apps/site` 才做：`(cd apps/site && npm run deploy)`，然后打开 https://getpupu.com 看改动在。细节见 `apps/site/README.md`。

## 收尾

关掉这次开的 TaskSpace。向用户报告一次：main 的提交、云端新旧版本号、电脑 App 版本、TestFlight 构建号和两个组的状态，以及没发的端和原因。
